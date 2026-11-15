# Photo fixtures (real encoder output)

Small JPEGs made by real, widely used encoders (libjpeg via ImageMagick, and FFmpeg's own MJPEG encoder) from one synthetic
160×120 drawing (a navy-to-orange gradient with a white circle, a black rectangle and a red triangle). No photo, camera, person or
private file was involved, and `-strip` / `-map_metadata -1` leave no metadata. They exist so the JPEG check is tested against
marker layouts it did not write itself, not only against `test/jpeg-fixture.ts`.

Made on 2026-11-15 with ImageMagick 6.9.12-98 (libjpeg-turbo) and FFmpeg 6.1.1 (Ubuntu 24.04):

    convert -size 160x120 gradient:navy-orange -fill white -draw "circle 80,60 80,20" \
      -fill black -draw "rectangle 10,10 50,40" -fill red -draw "polygon 120,10 150,50 100,50" src.png
    convert src.png -strip -sampling-factor 2x2 -quality 85 im-baseline-420.jpg
    convert src.png -strip -sampling-factor 2x2 -interlace JPEG -quality 85 im-progressive-420.jpg
    convert src.png -strip -sampling-factor 1x1 -interlace JPEG -quality 92 im-progressive-444.jpg
    convert src.png -strip -colorspace gray -interlace JPEG -quality 85 im-progressive-gray.jpg
    ffmpeg -i src.png -q:v 4 -map_metadata -1 -fflags +bitexact -flags +bitexact ffmpeg-baseline-420.jpg

| File | Encoding | Marker layout before the first scan |
|---|---|---|
| `im-baseline-420.jpg` | baseline, 4:2:0 | APP0, DQT, DQT, SOF0, DHT ×4 |
| `im-progressive-420.jpg` | progressive (10 scans), 4:2:0 | APP0, DQT, DQT, SOF2, DHT ×2; more DHT between scans |
| `im-progressive-444.jpg` | progressive (10 scans), 4:4:4 | as above |
| `im-progressive-gray.jpg` | progressive (6 scans), greyscale | APP0, DQT, SOF2, DHT |
| `ffmpeg-baseline-420.jpg` | baseline, 4:2:0 | DQT (2 tables in one segment), DHT (4 tables in one segment), SOF0 |
