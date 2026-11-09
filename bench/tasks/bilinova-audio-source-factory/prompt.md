The audio session in `crates/player-core` opens its audio by file path, and every reopen (a device-lost rebind, a track switch) re-derives the path. That ties audio to local files: a remote transport (for example SFTP) cannot supply audio. Introduce a factory-based audio source: the session holds a factory and every (re)open calls it.

Public API (in `player_core`, exported from the crate root):
- `trait MediaByteSource` already exists; it stays the byte-addressed source an open produces.
- `enum AudioSourceKind { Open, Decode, Device }` (`Open` is the default): which of the three things a session depends on refused. `Open`: the transport could not produce a source (missing file, refused connection, denied auth). `Decode`: bytes arrived and the decoder refused them. `Device`: the output device refused.
- `struct AudioSourceError { pub kind: AudioSourceKind, pub message: String }` with `AudioSourceError::open(message)` (kind `Open`), `Display` as `"audio source: <message>"`, `"audio decoder: <message>"` or `"audio device: <message>"` by kind, and `std::error::Error`.
- `trait AudioSourceFactory: Send + Sync { fn open(&self) -> Result<Box<dyn MediaByteSource>, AudioSourceError>; fn label(&self) -> String; }`. Every `open()` returns a fresh, independent source with its own cursor (one session's video and audio decoders each hold one). `label()` is a stable identity for logs and errors and never contains credentials.
- `PathAudioSourceFactory::new(path: impl Into<PathBuf>)`: the local-file factory. Its label is the path; opening a missing file fails with kind `Open` and a message that contains the path.

Inside the crate:
- An audio session holds an `Arc<dyn AudioSourceFactory>` instead of a path. The rebind path (device lost, rebuild) reopens through `factory.open()`. The native decoder opens from the byte source with the existing C entry point `bn_audio_decoder_open_source_stream` (no C changes).
- Opens are generation-numbered: a cancel or a newer open makes an in-flight open stale, and a stale open is abandoned at each blocking step (transport open, decoder open, device open) before it touches the device.
- Expose the source lifecycle as an `AudioSourceState` (exported) in the audio metrics, with the failure kind of the last failed open; every open failure is classified as transport, decoder or device.
- The existing public open functions that take a path keep their signatures (they wrap the path in a `PathAudioSourceFactory`).

Keep the workspace building and its tests passing, and add tests for the new behaviour.
