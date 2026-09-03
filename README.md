# Auto Browser Agent

Manifest V3 Chrome extension using Groq's `openai/gpt-oss-120b`.

## Install

1. Create a Groq API key in your Groq account.
2. Put this folder somewhere permanent.
3. Open `chrome://extensions`.
4. Enable Developer mode.
5. Click Load unpacked.
6. Select this folder.
7. Click the extension icon to open the side panel.
8. Enter the Groq key and a task.

## Model

`openai/gpt-oss-120b`

The extension intentionally sends one planning request per action and uses compact structured page state. It has a 30-step safety cap and exponential backoff for HTTP 429 responses.

## Important

This is a user-controlled browser automation prototype. Do not use it to bypass access controls, solve live graded examinations, or perform transactions/messages without the required human authorization.

For production deployment, put the Groq API call behind your own server instead of distributing a shared API key inside the extension.