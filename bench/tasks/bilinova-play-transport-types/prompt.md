The transport vocabulary (loop modes, playlist items, seek intents, ...) now has one definition in the framework, `fluent_ui::transport` (crates/fluent-ui, behind the non-default `transport` feature). The play page, `crates/bilinova/src/pages/play.rs`, still defines its own copies of three of these types: `LoopMode`, `PlaylistItem` and `TransportSeekIntent`. Make the page use the framework's types instead of defining them.

- Remove the three definitions from `play.rs` and use the ones from `fluent_ui::transport`; enable the `transport` feature for the `bilinova` crate.
- `render.rs` names `PlaylistItem` and `TransportSeekIntent` through `pages::play::`; that path must keep working.
- The loop-mode menu labels (the Chinese strings such as "播完暂停") are BiliNova's own copy and stay in the page; the framework's `LoopMode` does not know them. The list of modes for the menu comes from the framework's `LoopMode::ALL`.
- Behaviour does not change. Keep the workspace building and its tests passing.
