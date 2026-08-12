---
name: superwhite-hdr-glow
description: Use this skill when the user wants an image, logo, wordmark, or profile picture to render brighter than white on HDR displays, or asks about the glowing logo effect on LinkedIn. Triggers include "make my logo glow", "brighter than white", "superwhite", "HDR logo", "glowing logo for LinkedIn", "make the whites glow", or any request to prepare a company logo or feed image so it lights up in the LinkedIn feed. Also use when a user's HDR export lost its glow after uploading to LinkedIn. Do NOT use for ordinary glow, bloom, or outer-glow filter effects, for HDR video, or for tone mapping photographs.
---

# Superwhite: render whites brighter than white

## What this does

Embeds a Rec.2100 PQ colour profile into a JPEG and re-encodes the pixels to
match it, so the bright areas of the image use an HDR display's brightness
headroom. On an HDR screen the whites render visibly brighter than the white of
the page around them. On an SDR screen the same file looks like a normal image.

This is the effect behind the glowing Wiz, Port, Taboola and Lusha logos on
LinkedIn. It is the same pipeline that runs at https://superwhite.app.

## Why the obvious approach fails

Photoshop and Camera Raw export HDR JPEGs as **gain maps**: a normal image plus
a hidden second image, described by XMP metadata. LinkedIn re-encodes every
upload and discards both the extra image and the XMP. The glow dies on upload,
even though LinkedIn's own upload preview shows it working, because that preview
plays the local file before processing.

ICC colour profiles are the one thing LinkedIn's pipeline preserves. So the HDR
has to be carried by the colour profile, not by a gain map. That is what this
skill does.

## Usage

```bash
python3 superwhite.py <image>                      # writes <image>-superwhite.jpg
python3 superwhite.py logo.png --nits 1400
python3 superwhite.py logo.png --stops 2
python3 superwhite.py logo.png --square 400 --background '#4316B8'
python3 superwhite.py post.png --mode all -o glowing.jpg
```

Requires `numpy` and `pillow`. Install with `pip install numpy pillow` if the
import fails.

### Options

| Option | Default | Notes |
|---|---|---|
| `--nits` | 1000 | Peak luminance of the whites. 800 is tasteful, 1400 is strong, above 3000 looks blown out. |
| `--stops` | | Alternative to `--nits`, measured above SDR reference white. 2 stops is 812 nits. |
| `--threshold` | 0.7 | How bright a pixel must be before it gets boosted, 0 to 1. |
| `--mode` | highlights | `highlights` boosts bright areas only; `all` lifts the whole image. |
| `--background` | white | Fill colour for transparency, e.g. `'#4316B8'`. |
| `--square` | | Pad to a centred square canvas. Use `400` for a LinkedIn company logo. |
| `--quality` | 97 | JPEG quality. |

## Choosing settings

**Company logo or profile picture.** Use `--square 400` and set `--background`
to the brand colour. A white mark on a saturated background is the ideal input,
because the contrast between boosted white and unboosted background is what
reads as glow.

**Feed post image.** Leave the size alone. Use the default `highlights` mode so
only the bright areas lift and the rest of the image stays natural.

**Photographs.** This works but is rarely flattering. Smooth gradients are the
weak case for 8-bit PQ; flat graphics, logos and wordmarks are the strong case.

Start at 1000 nits. This is a spotlight, not a floodlight: the effect works
because it is unusual in the feed, and it stops working when it reads as a
flashbang.

## Preparing the input

1. Flatten to a solid background. JPEG has no alpha channel, and transparency
   flattened to the wrong colour ruins the contrast. The script flattens onto
   white by default; pass `--background` to override.
2. Make the areas you want to glow genuinely white, close to RGB 255. The boost
   targets the near-white range, so off-white greys lift much less.
3. Square canvas for a logo, native aspect for a feed image.

## After conversion

1. Check it on an HDR display: recent iPhone, iPad, MacBook, or a good OLED
   phone, in Chrome or Safari, with battery saver off. The whites should exceed
   the window chrome around them.
2. **Do not re-save the file in another tool.** Any re-encode that drops or
   replaces the ICC profile kills the effect. This includes screenshots, most
   editors, messenger compression, and copy-paste.
3. Upload to LinkedIn directly, without cropping or editing in the composer.
   Cropping in the composer triggers a re-process that strips the profile.
4. Verify from an HDR device after LinkedIn has processed it.

## Where the effect survives

| Surface | Works |
|---|---|
| LinkedIn feed images, organic | Yes |
| LinkedIn Sponsored Content | Yes |
| LinkedIn company logo and profile picture | Yes |
| LinkedIn video | No. The transcoder rewrites all colour metadata to BT.709. |
| Instagram feed | Needs gain-map HDR instead, which this does not produce. |
| Screenshots | No. A screenshot captures the tone-mapped SDR result. |

## Explaining it to a user

Roughly 200 nits is where an operating system maps ordinary white. An HDR panel
can physically output 1,000 nits and more, and that gap is reserved for HDR
content. The PQ transfer function stores absolute luminance rather than
brightness relative to screen white, so a PQ-tagged image can ask for 1,000 nits
and get it. Nothing is being broken or exploited at the display level; the image
is simply declaring itself as HDR content, truthfully.

Viewers on SDR displays see a normal image with slightly duller whites. That
graceful fallback is what makes this safe to ship.

## Credit

The underlying technique was first documented publicly by Tom Nick
(https://tn1ck.com/blog/abuse-hdr-images-for-marketing). This skill packages the
export pipeline from https://superwhite.app, which is free and runs entirely in
the browser with no upload if you would rather not run anything locally.
