In packages/coding-agent, `resizeImageInProcess` (`src/utils/image-resize-core.ts`) sends photos as PNG even when JPEG would be many times smaller. Its doc comment says it tries both PNG and JPEG and picks the smaller one, but whenever the PNG fits under `maxBytes` the PNG is returned. Photos therefore go out as multi-megabyte PNGs, and requests become large enough to fail or time out (issue #11551).

Example: a photo-like 1200×800 JPEG resized to fit 1000×1000 comes back as `image/png`; it should come back as `image/jpeg` at 1000 px wide, and no larger than it needs to be.

Fix this so that the smaller encoding is used. Screenshots and other images where PNG is smaller must still go out as PNG. Add a regression test, and keep the rest of the coding-agent test suite passing.
