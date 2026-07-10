# Superwhite — deploy checklist

Everything in this folder is ready to ship. What's left needs your accounts (~30 min total):

## 1. Repo + deploy (15 min)
- Create GitHub repo `superwhite`, push the contents of this folder (index.html at root)
- Cloudflare Pages -> Create project -> connect repo -> Framework: None -> Build output: `/`
- Live at superwhite.pages.dev immediately

## 2. Domain (5 min)
- Buy superwhite.io, add as custom domain in the Pages project
- If DNS is on Cloudflare it's automatic; otherwise add the CNAME they give you

## 3. Waitlist (5 min)
- Create a Tally form: "Get Superwhite Pro — early access"
  - Fields: email + radio (Pro EUR 9 / Agency EUR 29)
- Find & replace `https://tally.so/r/REPLACE_ME` in index.html (2 occurrences)

## 4. Analytics (5 min)
- Create the site in Plausible (domain: superwhite.io)
- Uncomment the analytics <script> block in index.html <head>

## 5. THE PROOF LOOP — do before announcing anything
- Open the live site on your MacBook (Chrome/Safari, battery saver off)
- Convert an image, download, post it to your personal LinkedIn
- Verify the glow on MacBook + iPhone; download the image back from
  LinkedIn and run: exiftool -ProfileDescription file.jpg
  -> must show the PQ/Rec.2100 profile
- Only then: launch per playbook (LinkedIn post -> HN Show HN with
  /blog/how-it-works.html -> Product Hunt -> Reddit -> influencer DMs)

## Later (not blocking launch)
- Payments: Lemon Squeezy product + license key validation, flip IS_PRO
  in index.html based on a stored valid key
- Batch processing (client-side w/ JSZip) for Agency
- Ultra HDR export for Instagram (libultrahdr WASM) = v2 launch
