#!/usr/bin/env node
/**
 * Fetch the latest Folio CI build (Windows binaries) from GitHub.
 *
 *   node scripts/fetch-latest-ci.mjs [--out DIR] [--source nightly|artifact] [--dry-run]
 *
 * Sources, in order of preference:
 *   1. nightly  — the rolling `nightly` prerelease republished on every push to
 *                 main. Fixed asset names mean plain HTTPS downloads; no auth.
 *   2. artifact — the newest successful `build-installers` run on main. Pulls
 *                 the `folio-windows-binaries` zip via the Actions API (30-day
 *                 retention) and extracts it with tar.exe (Windows) or unzip.
 *                 GitHub requires authentication for artifact downloads even on
 *                 public repos, so this source needs GITHUB_TOKEN (or GH_TOKEN).
 *
 * Anonymous GitHub API calls are rate-limited to 60/hour; release-asset
 * downloads do not count against it.
 */

import { spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const REPO = "rtshiva/folio_ebook_reader";
const API = `https://api.github.com/repos/${REPO}`;
const WORKFLOW = "build-installers.yml";
const ARTIFACT_NAME = "folio-windows-binaries";
const NIGHTLY_ASSETS = ["Folio-nightly.exe", "Folio-nightly-setup.exe", "Folio-nightly.msi"];
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

// ---- args -----------------------------------------------------------------

const argv = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const outDir = resolve(argValue("--out", "dist-ci"));
const source = argValue("--source", "auto");
const dryRun = argv.includes("--dry-run");

if (source !== "auto" && source !== "nightly" && source !== "artifact") {
  console.error(`Unknown --source "${source}" (expected nightly | artifact | auto)`);
  process.exit(2);
}

// ---- helpers ---------------------------------------------------------------

async function ghFetch(url) {
  const headers = {
    "User-Agent": "folio-fetch-ci",
    Accept: "application/vnd.github+json",
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(url, {
    redirect: "follow",
    headers,
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function downloadTo(url, dest) {
  // Release-asset and artifact-zip endpoints answer with a redirect to the
  // signed object store; fetch follows it transparently.
  const res = await ghFetch(url);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extractZip(zipPath, destDir) {
  // Windows 10 1803+ ships bsdtar as System32\tar.exe, which reads zip archives;
  // GNU tar (Git Bash) does not. unzip is the POSIX fallback.
  const systemTar =
    process.platform === "win32"
      ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
      : null;
  const attempts = [];
  if (systemTar) attempts.push([systemTar, ["-xf", zipPath, "-C", destDir]]);
  attempts.push(["tar", ["-xf", zipPath, "-C", destDir]]);
  attempts.push(["unzip", ["-o", zipPath, "-d", destDir]]);

  for (const [cmd, args] of attempts) {
    const r = spawnSync(cmd, args, { stdio: "pipe" });
    if (r.status === 0) return;
    if (r.error && r.error.code === "ENOENT") continue; // tool not installed
    const stderr = (r.stderr || "").toString().trim();
    throw new Error(`Extraction failed (${cmd} ${args.join(" ")}): ${stderr}`);
  }
  throw new Error("Could not extract the artifact zip: no usable tar.exe/unzip found.");
}

// ---- source plans ----------------------------------------------------------

async function planNightly() {
  const res = await ghFetch(`${API}/releases/tags/nightly`);
  const rel = await res.json();
  const assets = rel.assets
    .filter((a) => NIGHTLY_ASSETS.includes(a.name))
    .map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }));
  if (!assets.length) throw new Error("nightly release exists but has no matching assets");
  return {
    label: `nightly release (commit ${String(rel.target_commitish || "").slice(0, 7) || "unknown"}, published ${rel.published_at})`,
    assets,
  };
}

async function planArtifact() {
  if (!TOKEN) {
    const err = new Error(
      "artifact downloads require authentication even on public repos. " +
        "Set GITHUB_TOKEN (or GH_TOKEN) — e.g. `export GITHUB_TOKEN=$(gh auth token)` — " +
        "or use the nightly release, which needs no token.",
    );
    err.status = 401;
    throw err;
  }
  const runsRes = await ghFetch(
    `${API}/actions/workflows/${WORKFLOW}/runs?branch=main&status=success&per_page=1`,
  );
  const runs = await runsRes.json();
  const run = runs.workflow_runs && runs.workflow_runs[0];
  if (!run) throw new Error("no successful build-installers run found on main");
  const artsRes = await ghFetch(`${API}/actions/runs/${run.id}/artifacts`);
  const arts = await artsRes.json();
  const art = (arts.artifacts || []).find((a) => a.name === ARTIFACT_NAME && !a.expired);
  if (!art) throw new Error(`run ${run.id} has no live ${ARTIFACT_NAME} artifact`);
  return {
    label: `artifact from run ${run.id} (commit ${run.head_sha.slice(0, 7)}, ${run.created_at})`,
    assets: [
      {
        name: `${ARTIFACT_NAME}.zip`,
        url: `${API}/actions/artifacts/${art.id}/zip`,
        size: art.size_in_bytes,
        zip: true,
      },
    ],
  };
}

// ---- main ------------------------------------------------------------------

async function main() {
  let plan = null;
  let used = source;
  if (source !== "artifact") {
    try {
      plan = await planNightly();
      used = "nightly";
    } catch (e) {
      if (e.status !== 404) throw e;
      if (source === "nightly") {
        console.error("No nightly release yet — it appears after the first successful push to main.");
        process.exitCode = 1;
        return;
      }
      console.log("No nightly release yet; falling back to run artifacts.");
    }
  }
  if (!plan) {
    plan = await planArtifact();
    used = "artifact";
  }

  console.log(`Source: ${used} — ${plan.label}`);
  mkdirSync(outDir, { recursive: true });
  console.log(`Output: ${outDir}${dryRun ? " (dry run — nothing downloaded)" : ""}`);

  for (const asset of plan.assets) {
    const dest = join(outDir, asset.name);
    if (dryRun) {
      console.log(`  would fetch ${asset.name} (${mb(asset.size)})`);
      console.log(`    ${asset.url}`);
      continue;
    }
    process.stdout.write(`  fetching ${asset.name} (${mb(asset.size)}) ... `);
    await downloadTo(asset.url, dest);
    if (asset.zip) {
      extractZip(dest, outDir);
      unlinkSync(dest);
      const files = readdirSync(outDir)
        .map((f) => {
          const st = statSync(join(outDir, f));
          return st.isFile() ? `    ${f} (${mb(st.size)})` : null;
        })
        .filter(Boolean);
      console.log("extracted:");
      console.log(files.join("\n"));
    } else {
      console.log("done");
    }
  }

  if (!dryRun) {
    console.log(`\nLatest build ready in ${outDir}`);
    if (used === "artifact") {
      console.log("Note: artifact zips expire after 30 days — prefer the nightly release.");
    }
  }
}

// Exported for testing; the CLI runs via the guard below.
export { downloadTo, extractZip, planNightly, planArtifact };

// Only run the CLI when invoked directly; helpers stay importable for tests.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  // Set exitCode rather than calling process.exit(): on Windows, exiting while
  // a failed fetch's sockets are still closing trips a libuv assertion.
  main().catch((e) => {
    console.error(`fetch-latest-ci: ${e.message}`);
    process.exitCode = 1;
  });
}
