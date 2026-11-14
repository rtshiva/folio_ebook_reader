// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  #[cfg(target_os = "windows")]
  {
    let curr = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
    if !curr.contains("msWebView2EnableSharedArrayBuffer") {
      let new_args = if curr.trim().is_empty() {
        "--enable-features=msWebView2EnableSharedArrayBuffer --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection".to_string()
      } else {
        format!("{} --enable-features=msWebView2EnableSharedArrayBuffer", curr.trim())
      };
      std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", new_args);
    }
  }
  app_lib::run();
}
