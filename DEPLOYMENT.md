# Publish the website on Render

The Render blueprint in `render.yaml` runs the Node.js website and connects it to the existing PostgreSQL database. The dashboard and event history do not require a sign-in, so anyone with the deployed URL can view their contents.

## Deploy

1. Sign in to [Render](https://render.com/) with the GitHub account that owns `GasandFireSafety`.
2. Select **New** → **Blueprint** and connect the `TinamisanJethro-BSIT2E/GasandFireSafety` repository.
3. Review the `gas-fire-safety` web service. When prompted, enter `DATABASE_URL` using the PostgreSQL connection URI from the Supabase project. Do not paste it into source files or share it in chat.
4. Apply the blueprint and wait for the deployment health check to pass.
5. Open the public `onrender.com` URL shown on the service page.

Render generates a `DEVICE_API_KEY` for the service. To send simulator data, set that key and `DEVICE_SERVER_URL` to the Render service URL in a local `.env.local` file, then run `npm.cmd run simulate`. Keep the key private.

The free web service may sleep while idle, so the first request can take a while to respond. This hosted dashboard is for supplementary monitoring only, not a certified alarm or a replacement for local ESP32 safety controls. The current ESP32 firmware uses plain HTTP and is not configured for secure communication with an HTTPS-hosted server; do not send its API key over the public internet or configure the device for the public service until HTTPS certificate validation is implemented.
