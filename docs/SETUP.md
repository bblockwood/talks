# SETUP.md: one-time setup for Ben

Do this once, about 30 minutes total. Fable handles everything else. Dashboard menus move around occasionally; if a label doesn't match, search the dashboard for the bolded term.

---

## 1. GitHub

1. **Create the repo.** Create a repository named `talks`; the name becomes the URL path `/talks/`.
   - Public is fine, because decks are encrypted.
   - It can be private only if you have GitHub Pro, since Pages on private repos needs a paid plan. Either way, the published site itself is public.
2. **Pages source.** In **Settings → Pages**, set **Source** to **GitHub Actions**.
   - If your user site uses a custom domain, this repo automatically appears at `https://<your-domain>/talks/`.
   - Confirm **Enforce HTTPS** is checked on your user site's Pages settings. Fullscreen and the other browser features require HTTPS.
3. **GitHub CLI.** The publish tool uses it to trigger deploys. On the Mac:
   ```
   brew install gh
   gh auth login        # choose GitHub.com → HTTPS → "Login with a web browser"
   ```
   Over SSH it prints a one-time code. Open the URL it shows on any device and enter the code.

## 2. Cloudflare (the phone-remote relay)

1. **Account.** Sign up at cloudflare.com on the free plan. You don't need to move your domain or DNS to Cloudflare.
2. **Workers subdomain.** Open **Workers & Pages** in the dashboard. The first visit asks you to pick a `workers.dev` subdomain, e.g. `ben-econ`. Your relay will live at `https://lectern-relay.<subdomain>.workers.dev`.
3. **API token.** This avoids `wrangler login`, which opens a browser on the Mac and is awkward over SSH.
   - Go to **My Profile → API Tokens → Create Token**.
   - Use the **Edit Cloudflare Workers** template, limited to your account. All zones is fine; you won't be using zones.
   - Create it and copy the token. It's shown only once.
4. **Account ID.** Find it on the **Workers & Pages** overview, in the right sidebar, or on your account home page.
5. **Environment variables.** Add both to the Mac's shell, e.g. in `~/.zshrc`, or in a `.envrc` that is never committed:
   ```
   export CLOUDFLARE_API_TOKEN=…        # keep secret
   export CLOUDFLARE_ACCOUNT_ID=…       # not secret
   ```
   Open a new shell (or `source ~/.zshrc`).
6. **Deploy the relay.** Once Fable has built `relay/` (milestone W0):
   ```
   cd talks/relay && npm ci && npx wrangler deploy
   ```
   It prints the relay URL. Fable puts that URL in the site config and sets `ALLOWED_ORIGINS` to `https://<your-domain>`. Neither is secret.
7. **Check it.**
   - `curl https://lectern-relay.<subdomain>.workers.dev/health` should print `ok`.
   - `npx wrangler tail` streams live logs while you test with your phone.
8. **Optional auto-deploy.** To have GitHub redeploy the relay on changes, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository secrets under **Settings → Secrets and variables → Actions**. Tell Fable you've done it.

**Cost.** The free plan has hard daily limits, and exceeding them makes requests fail rather than billing you. A talk's relay traffic is a few thousand tiny messages, far below the limits.

## 3. Your talk codes

- **Where they live.** Codes are stored only on your Mac, in `~/.config/lectern/codes.json`.
  - Back that file up, e.g. into your password manager's secure notes.
  - Losing it isn't a disaster: republish with `--rotate-code` to get new codes.
- **Listing them.** `npm run codes` lists them.
- **On your phone.** Open `<your-domain>/talks`, enter a code once, and tick **Remember on this device**.

## 4. Before every external talk

1. `npm run publish -- talk.pdf --wait`, which keeps the same code on republish.
2. On your phone, open the remote and tap the talk. This also caches the slides on the phone.
3. Do a dry run on your laptop: open `<your-domain>/talks`, enter the code, choose **Presenter view**, and advance from the phone.
4. Pack:
   - A USB clicker.
   - The PDF on a USB stick.
   - Your iPad and an HDMI adapter as backup.
5. At the venue, use a private or InPrivate browser window on their PC.
