# Lark/Feishu Approval

[Back to setup guide](setup-guide.md)

Lark/Feishu Approval is an optional remote approval path for existing Clawd permission bubbles. When a supported agent asks for tool permission, Clawd keeps the local desktop bubble and also sends an approval card to your Lark/Feishu bot. The first explicit Allow or Deny decision resolves the same pending permission.

This is approval-only. It does not create a Lark/Feishu chat bridge, remote shell, or prompt-submission path.

## Supported Platforms

- **Feishu (飞书)** — For users in China: [open.feishu.cn](https://open.feishu.cn)
- **Lark** — For international users: [open.larksuite.com](https://open.larksuite.com)

Both platforms share the same API structure but use different endpoints. The `region` setting determines which endpoints to use.

## Supported Paths

- Claude Code and CodeBuddy normal permission requests.
- Codex CLI official `PermissionRequest` hooks when Codex permission handling is in intercept mode.

Lark/Feishu cards are not sent for DND/native-fallback cases, disabled agents, hidden permission bubbles, opencode, elicitation prompts, passive notifications, or headless sessions.

## Setup

The Settings tab walks you through three steps in order. Each step is gated until the previous one is saved, so the **Enable** switch and **Send test** button stay disabled until credentials and recipient are in place.

### Step 1 — Create Feishu/Lark App

#### For Feishu (飞书) users in China:

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) and create a new **Enterprise Self-Built App**.
2. In the app settings, enable the **Bot** capability.
3. Note down the **App ID** and **App Secret** from the app credentials page.
4. Under **Permissions & Scopes**, add the following permissions:
   - `im:message:send_as_bot` — Send messages as bot
   - `im:message` — Receive messages
5. Under **Event Subscription**, configure a **Request URL** (Webhook URL) where Clawd will receive card interaction callbacks. This should be accessible from the internet.
6. Publish the app (or use it in test mode within your organization).

#### For Lark international users:

1. Go to [Lark Open Platform](https://open.larksuite.com/app) and create a new **Enterprise Self-Built App**.
2. Follow the same steps as above for bot capability, permissions, and event subscription.

### Step 2 — Configure Clawd

Open Clawd Settings → **Remote Approval** → expand the **Lark/Feishu** card:

1. **Region** — Select **Feishu** (for China) or **Lark** (for International). This determines which API endpoints to use.
   - **Feishu**: `open.feishu.cn` (default, recommended for users in China)
   - **Lark**: `open.larksuite.com` (for international users)
2. **App ID** — Paste the App ID from step 1.
3. **App Secret** — Paste the App Secret from step 1. The secret is stored outside `clawd-prefs.json` in Clawd's user-data `lark-approval.env` file. After saving, the input collapses to a masked preview so you can tell two saved secrets apart without seeing the raw value.
4. **Chat ID** — Enter the target chat ID (for group chats) or user Open ID (for private messages). You can find this in the Feishu/Lark Open Platform's API Explorer or by using the Bot API.

### Step 3 — Enable & Test

1. Flip **Enable Lark approval**.
2. Click **Send test**.

The test sends a standalone approval card to your Lark chat. Tap either Allow or Deny within 60 seconds. It is not attached to any agent permission request. The status card at the top of the tab shows live connection state (Setup incomplete / Ready / Running / Failed) and surfaces any error message in plain text.

## Runtime Behavior

- The desktop permission bubble remains the local fallback.
- Lark timeout or network failure does not deny the tool. The local bubble stays usable and the agent's existing fallback behavior remains unchanged.
- If the desktop bubble resolves first, Clawd aborts the in-flight Lark approval request.
- Repeated Lark taps after a request is already handled do not resolve the permission twice.
- Logs redact Lark tokens, chat IDs, and token-like values.

## Text Reply Fallback

In addition to tapping buttons on the approval card, you can reply with a text message:

- **Allow**: `y`, `yes`, `allow`, `ok`, `允许`
- **Deny**: `n`, `no`, `deny`, `拒绝`

If multiple requests are pending, include the short code shown on the card: `y AB12` or `n AB12`.

## State Notifications

Optionally, Clawd can push agent state changes to your Lark chat as text messages. Configure which states trigger notifications in Settings:

- `attention` — Agent needs attention (e.g., permission request)
- `error` — Agent encountered an error
- `notification` — Agent sent a notification
- `sleeping` — Agent went to sleep

Notifications are throttled by `minIntervalMs` (default: 5 seconds) to avoid spam.

## Webhook Configuration

For card interaction callbacks to work, you need to configure a Webhook URL in the Lark Open Platform:

1. In your app's **Event Subscription** settings, set the **Request URL** to your server's public URL (e.g., `https://your-server.com/lark/webhook`).
2. If you don't have a public server, you can use a tunneling service like [ngrok](https://ngrok.com/) or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/).
3. The Webhook URL should point to Clawd's HTTP server. By default, Clawd listens on `127.0.0.1:23333-23337`. You'll need to set up port forwarding or a reverse proxy to expose this to the internet.

**Note**: If you're only using Lark for state notifications (not approval), you don't need to configure a Webhook URL.

## Troubleshooting

### "Setup incomplete" error
- Verify that App ID, App Secret, and Chat ID are all filled in correctly.
- Check that the App Secret hasn't expired or been regenerated.

### "Failed to send test" error
- Verify that your Lark app has been published (or is in test mode with you as a test user).
- Check that the bot has been added to the target chat (for group chats) or that you've sent `/start` to the bot (for private messages).
- Verify network connectivity to `open.feishu.cn`.

### Card buttons not working
- Ensure that the Webhook URL is correctly configured and accessible.
- Check that the event subscription includes `card.action.trigger` events.
- Verify that your server is correctly forwarding requests to Clawd's HTTP server.

### Token refresh failures
- Lark tokens expire after 2 hours. Clawd automatically refreshes them 5 minutes before expiry.
- If you see token refresh errors, verify that your App ID and App Secret are correct.
- Check that your Lark app hasn't been suspended or deleted.

## Security Considerations

- **Token Storage**: App Secret is stored encrypted in a separate file (`lark-approval.env`), not in `clawd-prefs.json`.
- **Sensitive Information**: Logs automatically redact tokens, chat IDs, and other sensitive values.
- **Permission Control**: Only the configured Chat ID can receive and respond to approval requests.
- **Timeout Handling**: Approval requests timeout after 5 minutes (configurable). The local bubble remains usable after timeout.

## Lark Open Platform References

- [Lark Open Platform](https://open.feishu.cn/)
- [Bot Development Guide](https://open.feishu.cn/document/home/develop-a-bot-in-5-minutes/create-an-app)
- [Message Card Documentation](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-structure)
- [Event Subscription Guide](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/application-v6/event-subscription-configure-)
