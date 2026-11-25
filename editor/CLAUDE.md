# open-slide server: environment notes

- This editor runs in a sandbox. Web access (web fetch, downloads, `npm install`, MCP servers) goes
  through a filtering proxy and only works if the server owner enabled it (`EDITOR_INTERNET`); local
  and private network addresses are always blocked. **Web search always works** (it runs on
  Anthropic's side). If something can't be reached, ask the user to paste the text or upload the
  file with the asset panel; don't try to work around the sandbox.
- Everything in the project folder is synced to the project's GitHub repo every few minutes.
  Never write secrets or personal data into project files.
