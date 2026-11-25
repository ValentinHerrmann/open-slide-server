# open-slide server: environment notes

- This editor runs in a sandbox **without internet access**. Opening URLs (web fetch), downloads
  and package installs (`npm install`) do not work. **Web search works** (it runs on Anthropic's
  side), but you only get the search results, not full pages. If you need a page's content or a
  file, ask the user to paste the text or upload it (e.g. as PDF) with the asset panel.
- Everything in the project folder is synced to the project's GitHub repo every few minutes.
  Never write secrets or personal data into project files.
