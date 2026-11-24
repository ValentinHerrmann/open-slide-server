# open-slide server: environment notes

- This editor runs in a sandbox **without internet access**. Web fetches, web search and package
  installs (`npm install`) do not work. Don't try to work around this; if something from the web
  is needed, ask the user to upload it with the asset panel in the editor.
- Everything in the project folder is synced to the project's GitHub repo every few minutes.
  Never write secrets or personal data into project files.
