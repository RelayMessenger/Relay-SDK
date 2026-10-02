# Public synthetic decoder fixtures

These are one-frame 64x48 FFmpeg `testsrc2` color patterns, not captured screens.
Generated with FFmpeg 6.0/libx264; no private images, NALs, URLs or device data.
The `.yuv` references are independent FFmpeg decoder output, retaining the
stream's range (full: YUVJ420P/pc; limited: YUV420P/tv). Tests compare all planes
byte-for-byte through the actual factory receiver and RTP assembler.

Reproduce from this directory:

```sh
ffmpeg -v error -f lavfi -i 'testsrc2=size=64x48:rate=1' -frames:v 1 \
  -vf scale=in_range=tv:out_range=pc -c:v libx264 -preset ultrafast -crf 18 \
  -pix_fmt yuvj420p -color_range pc -f h264 full-range.h264
ffmpeg -v error -f lavfi -i 'testsrc2=size=64x48:rate=1' -frames:v 1 \
  -c:v libx264 -preset ultrafast -crf 18 \
  -pix_fmt yuv420p -color_range tv -f h264 limited-range.h264
for range in full limited; do
  ffmpeg -v error -i "$range-range.h264" -frames:v 1 \
    -c:v rawvideo -f rawvideo "$range-range.yuv"
done
```

The full-range regression tests **sample preservation**, not range conversion.
The public Relay VideoFrame has no range metadata and its RGB conversion still
assumes limited range; that pre-existing limitation is outside this fix.

Additional guard/content fixtures (same public testsrc2 source):

```sh
ffmpeg -v error -f lavfi -i 'testsrc2=size=64x48:rate=1' -frames:v 1 \
  -c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p10le -f h264 masked-10bit.h264
ffmpeg -v error -f lavfi -i 'testsrc2=size=64x48:rate=1' -frames:v 1 \
  -c:v libvpx -b:v 1M -f ivf /tmp/synthetic-vp8.ivf
ffmpeg -v error -i /tmp/synthetic-vp8.ivf -frames:v 1 \
  -c:v rawvideo -f rawvideo vp8.yuv
# The one-frame IVF has a 32-byte file header and 12-byte frame header:
python3 -c 'from pathlib import Path; Path("vp8.vp8").write_bytes(Path("/tmp/synthetic-vp8.ivf").read_bytes()[44:])'
```

The 10-bit fixture deliberately decodes to an **unknown native format** while
node-webcodecs 1.3 reports public I420 and synthesizes a smaller I420 allocation.
The test asserts the real native allocation and rejection **before copyTo**, even
with a permissive input proof. VP8 is compared byte-for-byte with independent
FFmpeg output, just like the two H264 fixtures.
