const clientId = process.env.GITHUB_CLIENT_ID;
if (!clientId) throw new Error("Set GITHUB_CLIENT_ID before running this command.");

const deviceResponse = await fetch("https://github.com/login/device/code", {
  method: "POST",
  headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: clientId })
});
const device = await deviceResponse.json();
if (!deviceResponse.ok) throw new Error(device.error_description ?? "Could not start GitHub Device Flow.");

console.log(`Open ${device.verification_uri} and enter code: ${device.user_code}`);
const deadline = Date.now() + device.expires_in * 1000;
const interval = Math.max(device.interval ?? 5, 5) * 1000;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, interval));
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, device_code: device.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" })
  });
  const token = await tokenResponse.json();
  if (token.access_token) {
    console.log("\nKeep this token only in your local Codex/Claude configuration:");
    console.log(token.access_token);
    process.exit(0);
  }
  if (token.error !== "authorization_pending") throw new Error(token.error_description ?? "GitHub Device Flow failed.");
}
throw new Error("GitHub Device Flow expired before authorization completed.");
