# Offline TTS Neural Models

This directory holds neural text-to-speech models (specifically `kitten_tts_mini_v0_8.onnx`).
During CI and release packaging, `kitten_tts_mini_v0_8.onnx` is bundled into application resources
to power native multi-threaded ORT inference with sub-0.20 RTF performance.
