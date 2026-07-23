# Superwhite

**Make the whites in your image glow brighter than your screen's white.**

Live at **[superwhite.app](https://superwhite.app)**. Free, runs entirely in your browser, nothing gets uploaded.

This is the tool behind the "glowing logo" effect you may have seen in the LinkedIn feed from brands like Wiz. On HDR displays (recent iPhones, Pixels, MacBooks, OLED monitors) the whites in the exported image render in the display's extra brightness headroom, physically brighter than the white page around them. On SDR displays the image just looks normal.

## How it works

Superwhite re-encodes your JPEG with a Rec.2100 PQ ICC color profile, with per-pixel luminance masking so only the whites are boosted while colors stay accurate. LinkedIn's image pipeline strips most HDR metadata but keeps ICC profiles, so the effect survives feed post uploads. A nits slider controls how hard the glow hits, because tasteful beats searing.

Read more:

- [Why the Wiz logo glows on LinkedIn: the HDR glow trick explained](https://superwhite.app/blog/wiz-logo-glow-linkedin.html)
- [How it works, technically](https://superwhite.app/blog/how-it-works.html)
- [Why is that LinkedIn image glowing?](https://superwhite.app/blog/why-is-that-linkedin-image-glowing.html)

## Where the effect survives

- LinkedIn feed posts, uploaded directly as JPEG without cropping or editing in the composer
- It dies in: screenshots, re-saves in editors, WhatsApp and iMessage compression, copy-paste

## Architecture

Single HTML file, no build step, no server. Image processing happens in a canvas in the visitor's browser. A small Cloudflare Worker handles export credits.

## Credits

The underlying profile-splicing technique was first documented by [Tom Nick](https://tn1ck.com/blog/abuse-hdr-images-for-marketing). The company-page logo variant (PNG cICP) was documented by [Gal Tidhar](https://gal.tidhar.org.il/blog/hdr-glow-logo/). Superwhite packages the feed post variant as a self-serve, in-browser tool.
