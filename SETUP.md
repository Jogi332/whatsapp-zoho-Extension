# Per-Customer Setup Runbook

> **This is the LEGACY, per-customer-dedicated-project runbook.** A
> Marketplace-extension migration is in progress (see
> `~/.claude/plans/starry-swimming-wombat.md`) that moves new installs onto
> one shared, multi-tenant Catalyst backend with a self-service Settings
> page (`settings.html`) instead of the manual phases below. This document
> still describes exactly how EXISTING customers' dedicated-project
> deployments work and continue to be maintained (no forced cutover - see
> the plan's Phase F) - don't delete or "clean up" any of it until those
> customers are actually migrated. It will be rewritten once the self-service
> flow fully replaces it.
>
> **New/shared-backend installs (confirmed by Zoho Marketplace support -
> Sigma doesn't support Connections for CRM extensions, CRM Variables is the
> recommended pattern) need these additional CRM Variables that the legacy
> flow never used** (WorkDrive credentials used to be Catalyst console env
> vars per customer project - now they're CRM Variables like everything
> else, read by the widget and passed through per-request):
> `WORKDRIVE_CLIENT_ID`, `WORKDRIVE_CLIENT_SECRET`, `WORKDRIVE_REFRESH_TOKEN`,
> `WORKDRIVE_FOLDER_ID` (required for attachments), and optionally
> `WORKDRIVE_ACCOUNTS_HOST` / `WORKDRIVE_API_HOST` / `WORKDRIVE_HOST` /
> `WORKDRIVE_DOWNLOAD_HOST` for non-`.in` data centres - same values/lookup
> steps as Phase 4c below, just set as a CRM Variable instead of a Catalyst
> function environment variable.

How to install the Whatsyoo WhatsApp widget for a new customer.

**Architecture (decided Aug 9, 2026):**
- **Shared across all customers:** the widget itself (one GitHub Pages copy at
  `https://jogi332.github.io/whatsapp-zoho-widget/index.html` — every customer points at the same URL)
- **Per customer, in the customer's own account:** their Zoho CRM org, their Catalyst project
  (billed to them), their Engati bot

---

## ✅ How each customer's widget finds their own Catalyst

The widget is shared, but each customer has their **own** Catalyst project. The widget therefore
reads a **`CATALYST_BASE_URL`** CRM Variable from each org and derives its function endpoints from
it at runtime — same mechanism as the Engati credentials.

**Every new org MUST set `CATALYST_BASE_URL`** (Phase 5, CRM Variables table below). If it's missing, the widget falls
back to the original org's Catalyst project and logs a warning in the debug panel — meaning that
customer's widget would call **another customer's** functions, using **that** customer's Engati
credentials. Wrong bot, wrong messages, cross-customer data leak.

Format: the project's base URL, no path — e.g. `https://<project>-<id>.catalystserverless.in`
Trailing slashes and a trailing `/server` are tolerated.

⚠️ Note the **data centre** suffix. A customer on the US/EU/AU DC gets an entirely different
domain (`.com`, `.eu`, …), not just a different project name. Copy it from their Catalyst console,
don't assume `.in`.

---

## Phase 1 — Start the long-lead items first

These are blocked on other people. Kick them off before anything else.

1. **Request External Live Chat from Engati** for the customer's bot. Their docs say it's
   *"available only on request"* — contact `contact@engati.ai`. Lead time is outside our control.
   Without it, free-text replies are impossible (only templates work).
2. **Confirm the customer has Zoho CRM admin access** — needed for Setup → Developer Hub.
3. **Confirm they'll add a payment method to their Catalyst account.** Catalyst **Production**
   will not activate without one. Development works free, but Production is where this runs.
4. **Decide deploy access.** Cleanest is the customer adding you as a Catalyst
   **collaborator/admin**, so you can deploy from your own machine:
   `catalyst deploy -p <project> --org <their-org-id>`. Otherwise every deploy is manual console
   work in their account.

---

## Phase 2 — Engati bot

5. Get from the customer's Engati account: **Customer ID**, **Bot Key**, **API Key**.
6. **Check EVERY conversation path in Bot Builder for a "Transfer to Agent" node.**
   `app.connectpanels.com/admin/builder`
   - Not just "Welcome new user" — check "Greet returning user", "Default Message", and any
     custom paths.
   - **This cost us a full day.** A returning user hitting a path with no Transfer to Agent node
     never enters live chat, so every `AGENT_MESSAGE` fails with `1004 USER_NOT_IN_LIVE_CHAT`
     forever, no matter how correct the code is.
   - Also check **"Post resolution"** if you plan to use a Resolve button — a path that dead-ends
     with no Transfer to Agent may strand customers.
   - **"Agent Unavailable" is the one path that legitimately shouldn't get one** — transferring
     when the reason you're on this path *is* "no agent available" just loops back to the same
     state. Engati's own "Add Node" picker didn't even offer Transfer to Agent when tried on this
     specific path, which suggests this is by design, not an oversight.
   - The output dot on a node (bottom-right corner) opens an "Add Node" picker that **creates and
     connects in one step** — far more reliable via the UI than dragging a connector between two
     existing nodes, which is fiddly and easy to get wrong.
7. In **Configure → External Live Chat**, once enabled, copy the **Inbound Message Webhook URL**
   (Engati generates this; it's where we send `AGENT_MESSAGE`/`RESOLVE_LIVE_CHAT`).
   Leave **External Webhook URL** blank for now — filled in at Phase 4.

---

## Phase 3 — Catalyst project (customer's account)

8. **Create the project** in the customer's Catalyst console. The *first* project on a brand-new
   account **must** be created via the web console — `catalyst init` can't create it.
9. **Deploy the functions.** From this repo:
   ```
   catalyst deploy --only functions:liveChatSender,functions:liveChatWebhook,functions:fileUpload -p <project> --org <org-id>
   ```
   All three are `advancedio`, `node20`. Note `whatsappProxy` is **not** in `catalyst.json` — it's
   console-managed only; create/paste it manually in their console, with **their** Engati
   credentials hardcoded at the top (that's fine and intended under the per-customer model).
   `fileUpload` (device attachment uploads, see Phase 4c) is optional — skip its deploy if the
   customer doesn't need device-upload attachments.

   ⚠️ **A brand-new function is NOT reachable at its `/server/<name>/` URL until it also has an
   API Gateway route**, if this project has API Gateway enabled (Serverless → Security Rules →
   "API Gateway is enabled" banner — check this on every new customer's project, it may not
   always be on). `catalyst deploy` succeeding, the Overview tab showing a URL, and the Code tab
   showing the right files are **all true and still mean nothing** — every call returns a
   gateway-level `{"error_code":"INVALID_URL"}` with **zero invocations counted**, which looks
   exactly like deploy failure or propagation delay but is neither. `liveChatWebhook`/
   `liveChatSender`/`whatsappProxy` already have routes (created before API Gateway was enabled,
   or in an earlier setup pass) — a **new** function like `fileUpload` needs its own, created
   manually: Cloud Scale → **API Gateway** → **Create API** → match the shape of an existing
   route exactly (**Method: `ANY`**, **URL: `/server/<name>/{path1:(.*)}`**, **Target: Advanced
   I/O → \<name\>**, **No Authentication**). Only needs doing **once, in Development** - the
   Development→Production deployment (step 11) carries the route across automatically (confirmed:
   the deployment's diff view showed `API Gateway: Added 1` for the new route, and it worked in
   Production immediately after promotion with no separate route creation needed). After creating
   the route in Development, expect it to work **inconsistently for up to a few minutes** (some
   requests succeed, most still 404) while it propagates across edge nodes — that's normal, not a
   sign something's
   still wrong; poll every ~10s rather than giving up or re-creating the route.
10. **Create the `LiveChatEvents` Data Store table.** Columns (all type **Text**, none mandatory,
    none unique):

    `packet_type`, `user_id`, `bot_key`, `platform`, `message_type`, `text_value`,
    `media_value`, `media_mime_type`, `livechat_category`, `raw_payload`, `received_at`

    ⚠️ **Create it in BOTH Development and Production.** `catalyst deploy` only touches
    Development. A table missing in Production fails **silently** — the insert is caught and
    logged server-side only, so everything looks fine while nothing is recorded. This bit us.
11. **Promote to Production:** Settings → Environments → **Deployments** → *Create Deployment*
    (Development → Production). Select only what you mean to touch. `catalyst deploy` alone
    **never** reaches Production.
12. **Verify Production is actually live**, not just "deployed":
    ```
    curl -s -X POST "https://<project>.catalystserverless.<dc>/server/liveChatWebhook/" \
      -H "Content-Type: application/json" -d '{}'
    ```
    Expect `{"ok":true,...}`. Note the Production URL has **no** `.development.` segment.

---

## Phase 4 — Wire Engati → Catalyst

13. In Engati **Configure → External Live Chat**, set **External Webhook URL** to the customer's
    **Production** `liveChatWebhook` URL. Save.
    - Engati validates by POSTing an empty body and requires a **2xx** — if it doesn't save,
      the endpoint is wrong or not deployed to Production.
14. Confirm the validation ping landed in their `LiveChatEvents` table.

---

## Phase 4b — Zoho CRM API access, for Lead auto-creation

Only needed if the customer wants a CRM Lead created automatically when a new
WhatsApp contact messages them. Skip entirely if not — everything else works without it.

**This is per customer.** The credentials belong to *their* Zoho account, not ours.

15. In **their** Zoho API Console (`api-console.zoho.<dc>`), create a **Self Client**:
    - Scope: `ZohoCRM.modules.leads.ALL`
    - Generate a code (10 min expiry), select the **CRM** portal and their org
16. Exchange the code for a **refresh token** (refresh tokens don't expire):
    ```
    curl -X POST https://accounts.zoho.<dc>/oauth/v2/token \
      -d "grant_type=authorization_code" \
      -d "client_id=<CLIENT_ID>" \
      -d "client_secret=<CLIENT_SECRET>" \
      -d "code=<GRANT_CODE>"
    ```
17. Set these as **environment variables on the `liveChatWebhook` function** in
    *their* Catalyst console (Serverless → Functions → liveChatWebhook →
    Configuration). They are deliberately **not** in git:

    | Variable | Value |
    |---|---|
    | `ZOHO_CLIENT_ID` | from step 15 |
    | `ZOHO_CLIENT_SECRET` | from step 15 |
    | `ZOHO_REFRESH_TOKEN` | from step 16 |
    | `ZOHO_ACCOUNTS_HOST` | `accounts.zoho.in` — **change for other DCs** (`.com`, `.eu`) |
    | `ZOHO_API_HOST` | `www.zohoapis.in` — **change for other DCs** |
    Getting the hosts wrong fails authentication in a confusing way, so copy
    them from the customer's own console URLs rather than assuming.

    No country-code setting is needed here: Engati always supplies the full
    international number, and Leads are always written as `+<digits>`.

    ⚠️ **Three traps in that dialog, all of which fail silently:**
    - **Select Environment defaults to "Development".** Choose **Both**, or
      Production — the one Engati actually calls — stays unconfigured.
    - **"Both" does not copy the value across.** It reveals *two* boxes,
      **Development value** and **Production value**; paste the same value
      into each. The **Key** box is the variable name, never a value.
    - ☠️ **The `code` field in `self_client.json` is NOT the refresh token.**
      It's the one-time grant code from step 16, already exchanged and expired
      within minutes. The JSON contains only `client_id` and `client_secret`;
      the refresh token exists only in whatever you saved step 16's response
      to.

    A wrong or missing value here produces **no error anywhere** — the
    webhook still answers Engati with HTTP 200, no Lead appears, and the
    function's invocation-error count stays at zero. Always finish with the
    Phase 6 test below.

**How it behaves:** fires on every inbound WhatsApp message, searches for an
existing Lead by phone, creates one only if absent (`Last_Name` = the WhatsApp
profile name, or `WhatsApp <number>` if none; `Lead_Source` = `WhatsApp`).
Failures never break the webhook — they're logged and the next message retries.

⚠️ **The real name is only ever available on `START_CHAT`, not
`USER_MESSAGE`.** `USER_MESSAGE` (the trigger for most Lead creation, see
below) carries no name data at all — Engati's own doc confirms this, it's
not a bug. So a Lead created from someone's very first message will show
`WhatsApp <number>` until a `START_CHAT` eventually arrives for that
contact (i.e. their path hits Transfer to Agent), at which point the code
**backfills** the placeholder to their real name automatically - no manual
fix needed. If a customer's bot has paths with no Transfer to Agent node
(see Phase 2 step 6), contacts stuck on those paths will never get their
name backfilled and stay `WhatsApp <number>` forever. One more reason that
audit matters beyond just live-chat delivery.

⚠️ **Why it doesn't just use `/search`:** Zoho's search index lags writes by
**20+ seconds** (measured). A new contact sending three quick messages produced
three duplicate Leads. `/upsert` with `duplicate_check_fields` doesn't fix it
either — that only dedupes on fields marked unique in the CRM, and `Phone`
isn't. Recently-created numbers are therefore cached (in-process + Catalyst
Cache) until the index catches up. Don't "simplify" this back to a plain search.

### Why not Engati's built-in Zoho CRM node?

Engati's Bot Builder **does** ship a native Zoho CRM node (Add Node →
Integrations → Zoho CRM), brokered by **Integry** (`app.integry.io`). It was
evaluated on Aug 9, 2026 and rejected. Don't spend an afternoon re-evaluating
it — here's what it does and doesn't do.

What works: connecting an account is a normal OAuth flow (pick the right data
centre — `zoho.in` vs `.com` — and the PRODUCTION org, not the developer one).
It reaches every Lead field including **Phone**, and exposes bot variables to
map in, notably **`user.channel_user_id`**, which on WhatsApp is the phone
number.

Three reasons it loses to `crmLeads.js`:

1. **It is create-only.** The entire action list is Create Account / Campaign /
   Contact / Deal / Lead / Meeting / Task, and Delete Account / Contact / Deal.
   There is **no Search, Find, Update or Upsert**, so the node cannot check
   whether a Lead already exists. Dedup can only happen by marking `Phone`
   unique and letting Zoho *reject* the create — and it's untested whether that
   rejection surfaces as an error mid-conversation to the customer.
2. **It only fires where you place it.** A node runs when a conversation
   reaches that point on that path. `crmLeads.js` fires on every inbound
   message. Placing the node after Transfer to Agent means only people who
   reach a human become Leads — and it must be duplicated onto **every** path
   (including "Greet returning user"), the same trap that once left live chat
   silently unreachable.
3. **The OAuth scope is far broader.** It requests
   `ZohoCRM.modules.all` + `ZohoCRM.settings.all` + `ZohoCRM.users.READ` —
   full read/write across the whole CRM, held by a third party. `crmLeads.js`
   uses `ZohoCRM.modules.leads.ALL`.

☠️ **Builder edits are live immediately.** Adding a node writes straight into
the running flow — there is no unsaved-draft state, and the node's own "Save"
button only saves its *field mappings*. Worse, the node inserted itself **in
place of** Transfer to Agent rather than after it, orphaning the handoff and
breaking live chat on that path. **Always reload the builder after any edit
and re-check the wiring**, and if a node needs removing use the trash icon in
its hover toolbar (a click) rather than trying to drag connectors.

---

## Phase 4c — WorkDrive access, for device-upload attachments

Only needed if the customer wants the widget's "Upload file…" button (lets an
agent attach a file straight from their device instead of pasting an
already-hosted URL). Skip entirely if not — the URL-paste attachment field
still works without this, and free-text messaging itself doesn't depend on it.

**This is per customer**, same as Phase 4b, and can reuse the **same** Self
Client created in Phase 4b — Zoho allows only **one** Self Client per
account, so a second dedicated one can't be created. What's separate is the
**refresh token**: generate a new one scoped to WorkDrive rather than
reusing the CRM one, which won't have the right permissions.

1. In **their** Zoho API Console, on the **same** Self Client from Phase 4b,
   generate a new code:
   - Scope: `WorkDrive.files.ALL,WorkDrive.links.ALL,WorkDrive.team.READ,WorkDrive.workspace.READ,WorkDrive.teamfolders.READ`
   - Generate a code (10 min expiry)
2. Exchange it for a refresh token, same `oauth/v2/token` call as Phase 4b
   but with this code.
3. **Find the destination folder's resource id.** Simplest way: in the
   customer's WorkDrive web UI, open (or create) the folder attachments
   should upload into, and read the id out of its URL —
   `https://workdrive.zoho.<dc>/folder/<FOLDER_ID>`. For their "My Folders"
   root specifically, it's their **privatespace id** instead: `GET
   https://www.zohoapis.<dc>/workdrive/api/v1/users/<zuid>` (with the
   access token from step 2) → `relationships.privatespace` → that id.
4. Set these as **environment variables on the `fileUpload` function**
   (Serverless → Functions → fileUpload → Configuration), **Select
   Environment: Both** (same trap as Phase 4b's env var step):

   | Variable | Value |
   |---|---|
   | `WORKDRIVE_CLIENT_ID` | same Client ID as Phase 4b |
   | `WORKDRIVE_CLIENT_SECRET` | same Client Secret as Phase 4b |
   | `WORKDRIVE_REFRESH_TOKEN` | from step 2 above — **not** the CRM one from Phase 4b |
   | `WORKDRIVE_FOLDER_ID` | from step 3 above |
   | `WORKDRIVE_ACCOUNTS_HOST` | `accounts.zoho.in` — change for other DCs |
   | `WORKDRIVE_API_HOST` | `www.zohoapis.in` — change for other DCs |
   | `WORKDRIVE_HOST` | `workdrive.zoho.in` — change for other DCs (**different domain from `WORKDRIVE_API_HOST`, both are used**) |
   | `WORKDRIVE_DOWNLOAD_HOST` | `files-accl.zohoexternal.in` — change for other DCs (**a third, different domain**) |

   All four hosts matter and none can be derived from another — see the
   recipe under "Known limitations" below for why there are three separate
   WorkDrive domains in play, not one.

**How it behaves:** the widget's "Upload file…" button reads the picked file
as base64, POSTs it to `fileUpload`, which uploads it to the configured
WorkDrive folder, creates a public download link, and returns a direct,
unauthenticated, single-GET-fetchable URL — which auto-fills the existing
`attachUrl` field, reusing the already-working send pipeline. Files are
capped at 15MB (`MAX_UPLOAD_BYTES` in `fileUpload/index.js`) — untested
against Catalyst's own request-body limit, lower this if uploads start
failing on large files rather than assuming WhatsApp's own limits are the
binding constraint.

---

## Phase 5 — Zoho CRM (customer's org)

18. **Register the widget:** Setup → Developer Hub → Widgets → Create New Widget
    - Type: **Related List** (note: type is **locked after creation** — can't convert to Button later)
    - Hosting: **External**
    - Base URL: `https://jogi332.github.io/whatsapp-zoho-widget/index.html`
19. **Add it to the Lead layout** as a related list.
20. **Create CRM Variables:** Setup → Developer Hub → Variables

    | Variable | Required | Notes |
    |---|---|---|
    | `ENGATI_CUSTOMER_ID` | yes | |
    | `ENGATI_BOT_ID` | yes | Bot Key |
    | `ENGATI_API_KEY` | yes | |
    | `ENGATI_INBOUND_MESSAGE_WEBHOOK_URL` | for free-text | From Phase 2 step 7 |
    | `ENGATI_LIVECHAT_BOT_IDENTIFIER` | for free-text | ⚠️ **NOT the same value as `ENGATI_CUSTOMER_ID`**, despite both looking like "the bot ID" — see the callout below. Required for `AGENT_MESSAGE`/free-text sending; without it Engati accepts the request (200, real messageId, errorCode:null) and silently never delivers it. |
    | `ENGATI_INBOUND_API_KEY` | optional | Only if they set one in Engati |
    | `CATALYST_BASE_URL` | **yes** | **Their own** Catalyst project base URL, from Phase 3. Mind the data centre suffix. Omitting this silently points them at another customer's Catalyst. |
    | `DEFAULT_COUNTRY_CODE` | rarely | Digits only, no `+` — e.g. `1` (US/Canada), `44` (UK), `971` (UAE). Defaults to `91`. Applied **only** to a CRM number stored without a country code, which shouldn't happen: Leads are auto-created from WhatsApp as `+<international>`. It matters only if someone hand-edits a number into national format, and the widget shows a red banner when it kicks in. |

    **Multi-country orgs need no extra setup**, as long as numbers keep their
    leading `+` — which they do automatically, since every Lead is created by
    `crmLeads.js` from Engati's full international number. `DEFAULT_COUNTRY_CODE`
    can only ever assume one country, so it is a fallback, not the mechanism.

    ⚠️ **`ENGATI_CUSTOMER_ID` and `ENGATI_LIVECHAT_BOT_IDENTIFIER` are two
    different values that both plausibly answer to "bot ID" — do not
    conflate them, this cost a full session to diagnose (ES-58715).**
    `ENGATI_CUSTOMER_ID` is the short number labelled "Customer Identifier"
    on Engati's own Integrations screen (e.g. `126125`) — correct for the
    Conversation History and Template APIs. `ENGATI_LIVECHAT_BOT_IDENTIFIER`
    is a longer, base64-looking token (e.g.
    `eyJib3RSZWYiOjE0NzkxNCwidXNlcnNCb3RSZWYiOjE0NzkxNH0=`, which decodes to
    `{"botRef":...,"usersBotRef":...}`) that only appears in the top-level
    `botIdentifier` field of a genuine `START_CHAT` packet — required
    specifically for `AGENT_MESSAGE`/`RESOLVE_LIVE_CHAT`.

    **How to capture the real value on a new bot:** get a message sent from
    a WhatsApp number that has never talked to this bot before, so the bot
    flow hits Transfer to Agent cleanly (not manually picked up by an agent
    from Engati's portal — that produces a `START_CHAT` too, but Engati
    support has confirmed it doesn't count as a proper session for
    `AGENT_MESSAGE` purposes). Then query the `LiveChatEvents` Catalyst
    table for that number's `START_CHAT` row and read `botIdentifier` out of
    its `raw_payload` JSON. Don't guess, and don't reuse the Customer ID —
    every `AGENT_MESSAGE` sent with the wrong value here is accepted and
    silently never delivered, which looks identical to every other failure
    mode in this system.

21. **Mark `Phone` unique on the Leads layout** (safety net for the dedup
    above): Setup → Modules and Fields → Leads → Layouts → Standard → `...`
    menu on the **Phone** field → **"Do not allow duplicate values"** →
    **Save**. Not an API setting - only in the layout editor, and the
    change doesn't take until you explicitly Save.

    First **list every existing Lead's phone** and confirm no duplicates -
    Zoho refuses to apply uniqueness otherwise, with an unhelpful error.

    This only actually protects the org because every Lead here is created
    by `crmLeads.js` in the identical `+<digits>` format - Zoho's
    uniqueness check is a literal string match, so `+919061084736` and
    `09061084736` would both be accepted as "unique". If this customer ever
    creates Leads by hand or via import, this stops being a reliable
    safety net.

    ⚠️ A duplicate-phone rejection looks like `{"code":"DUPLICATE_DATA",
    "details":{"id":"<id>"}}` - that `id` is the **existing** record that
    blocked the write, not a new one. Don't mistake it for a leak.

22. **Create the `WhatsApp_Templates` custom module.** Fields actually read by the code:

    | Field | Purpose |
    |---|---|
    | `Template_Name` | **Must exactly match** the template name in Engati |
    | `Language_Code` | e.g. `en_US` |
    | `Header_Type` | `None` / `Image` / etc. |
    | `Header_Value` | Public image URL (see gotcha below) |
    | `Body_Param_Count` | Number of `{{1}}`-style variables |
    | `Body_Param_Labels` | UI labels for the parameter inputs |
    | `Button_Flow_Keys` | Semicolon-separated quick-reply payloads |
    | `Button_Start_Index` | Button index offset |
    | `Is_Active` | Unchecked = hidden from the dropdown |

    Note: the module's own "Name" field is just a human label — `Template_Name` is what's sent.

23. **Add a record per approved Engati template.**

---

## Phase 6 — Verify (do not skip)

24. **Send a template from the widget → check the real phone.**
25. **Message the bot from WhatsApp → confirm it appears in the widget.**
26. **Send free text from the widget → check the real phone.** Not just a
    success response - `AGENT_MESSAGE` returning `messageId`/`errorCode:null`
    means Engati accepted the packet, nothing more. This exact pattern
    stayed "successful" for days while wired to the wrong `botIdentifier`
    (see Phase 5's callout) - only a phone check catches it.
27. **Prove Lead auto-creation with a number that has no Lead yet.** This is
    the only test that distinguishes working dedup from a completely dead code
    path — "no duplicates appeared" proves nothing on its own, and passed
    convincingly while the whole CRM path was broken.

    ```bash
    URL="https://<their-project>.catalystserverless.<dc>/server/liveChatWebhook/"
    send() { curl -s -X POST "$URL" -H "Content-Type: application/json" \
      -d "{\"externalPacketType\":\"USER_MESSAGE\",\"userId\":\"$1\",\"botKey\":\"<BOT_KEY>\",\"platform\":\"dialog360\",\"body\":{\"packetType\":\"text\",\"text\":{\"value\":\"test\"}}}"; }
    send <brand-new-number>    # must create exactly one Lead, named "WhatsApp <number>"
    send <same-number>         # must NOT create a second
    send <same-number>         # ditto — exercises the cache layers
    send <existing-contact>    # must match, no new Lead
    ```

    Note: this simulates `USER_MESSAGE`, which never carries a name (no
    `userName` field exists anywhere in Engati's packets - don't add one to
    this test, it won't do anything). The created Lead is correctly named
    `WhatsApp <number>` here; a real name only ever arrives via `START_CHAT`
    and gets backfilled automatically, see the callout above.

    Then list Leads via the CRM API and assert no duplicate phone digits.
    Confirm DevOps → Logs shows `lead sync for <number>: insert Lead <id>` or
    `existing Lead <id>`, **not** `FAILED:`. Logs lag ~5 minutes, so refresh
    after a wait rather than assuming they're missing. Delete the test Leads
    afterwards.

---

## Gotchas that cost us real time

- **A `SUCCESS` response with a `message_id` does NOT mean delivered.** Engati's API accepting a
  send and Meta actually delivering it are separate things. Always verify on a real phone.
  Per-recipient failures appear **only** in Engati's **Broadcast History**, and even there only as
  a "Failed Users" count — the actual Meta error code needs Engati support to look up.
- **Header/media image URLs must be plain, directly-fetchable files.** A Wikimedia thumbnail URL
  produced Meta error **131053 (Media Upload Error)** — accepted by the API, silently never
  delivered. Avoid redirects, encoded special characters, and anything not a direct file.
- **`Content-Type: text/plain` on all widget→Catalyst `fetch()` calls.** Catalyst's gateway answers
  the CORS preflight itself with no `Access-Control-Allow-*` headers, so `application/json` (which
  triggers a preflight) always fails with "Failed to fetch". `text/plain` skips the preflight
  entirely. The functions `JSON.parse()` the body regardless.
- **`userId` for `AGENT_MESSAGE` differs by channel.** WhatsApp (`platform: "dialog360"`) uses the
  **plain phone number**. The UUIDs in `/conversations` belong to `platform: "web"` test sessions —
  sending to those silently drops. Read the real values off actual inbound packets in
  `LiveChatEvents`; don't assume.
- **`platform` is the BSP name, not `"whatsapp"`.** This bot reports `dialog360`. A customer on a
  different WhatsApp provider will report something else — read it off their packets.
- **Bump the `?v=` query string in `index.html` on every widget deploy.** Zoho caches widget
  content separately from GitHub Pages, and GitHub Pages' CDN caches for ~10 min. Without a bump,
  changes appear deployed but don't reach the widget.
- **`botIdentifier` in `AGENT_MESSAGE` is NOT `ENGATI_CUSTOMER_ID`, despite looking identical in
  purpose.** Cost a full session (ES-58715). See the callout in Phase 5's CRM Variables table for
  the full explanation and how to capture the real value on a new bot.
- **This repo keeps TWO copies of the function source** — `catalyst-functions/` (edit here) and
  `functions/` (what `catalyst.json` actually deploys). They can silently diverge. Always `cp` the
  changed file across and `diff` before deploying.
- **`catalyst deploy` only ever reaches Development**, regardless of which environment is selected
  in the console header. Production needs the separate Deployments → Create Deployment flow (see
  Phase 3 step 11) every single time, including for comment-only changes.
- **When testing anything that could silently no-op, include a case that MUST produce a visible
  change** (a brand-new phone number that must create a Lead, a message that must arrive on a real
  phone). A test that only checks "nothing bad happened" cannot distinguish a working feature from
  a completely dead code path — this exact mistake happened twice this project.
- **A Zoho account gets exactly ONE Self Client**, ever - the API Console refuses to create a
  second one ("Kindly use the same for generating codes"). Different-scoped OAuth grants (e.g. a
  CRM-only token vs. a WorkDrive-only token) come from **the same Client ID/Secret**, just
  separate `Generate Code` → token-exchange calls with different `scope` strings. This still
  gives independently-revocable, independently-scoped refresh tokens - it just means "separate
  OAuth app per integration" isn't available as an isolation boundary on Zoho; scope strings are
  the only boundary you get.
- **WorkDrive's upload/link/download flow spans THREE different hostnames**
  (`www.zohoapis.in` for upload, `workdrive.zoho.in` for creating a public link,
  `files-accl.zohoexternal.in` for the actual raw-bytes download) - using the wrong host for any
  one of them fails in a way indistinguishable from a payload bug (a generic 500 or an HTML page
  instead of file bytes). See Phase 4c for the full recipe, verified by intercepting WorkDrive's
  own web UI request rather than trusting third-party blog posts (one specific claim -
  `?directDownload=true` on the plain share link - turned out to be simply wrong).
- **`ZohoCatalyst` does not support Zoho's Data Center Migration process at all** - confirmed
  directly by Zoho's own DCM request form (`dcm.zoho.in/dcm-request-form`), which lists it
  alongside `ZohoSignals`, `WriterAutomation`, `PlatformAI`, `CRMPlatform`, `RTCPlatform` as
  explicitly excluded. If this org's data center ever needs to change, **the entire Catalyst
  project - every function, the Data Store, Cache, everything in this repo's `functions/` -
  has to be rebuilt from scratch in the new DC**, not migrated. `CRMPlatform` is also excluded,
  which may cover custom Client Scripts/widget registrations (i.e. how this widget itself is
  wired into CRM) - not confirmed, worth asking Zoho support directly if this ever becomes live.
  The DCM form itself is low-stakes to fill out ("migration will be initiated only after further
  communication with you"), but don't treat a submitted form as movement on this - Catalyst isn't
  going anywhere without a manual rebuild regardless of what Zoho says next.

---

## Known limitations to set expectations on

- **No read receipts / blue ticks.** Engati's API doesn't expose message read status.
- **Device-upload attachments: 15MB file size limit.** Enforced in two places -
  `catalyst-functions/fileUpload/index.js`'s `MAX_UPLOAD_BYTES` (server-side, returns a `413` with
  a clear message if exceeded) and mirrored client-side in `app.js`'s own `MAX_UPLOAD_BYTES` check
  (rejects immediately with an alert, before wasting time on a base64 read + upload attempt that
  would just fail at the end anyway - this is what made large video uploads look like a silent
  hang before the client-side check was added). Shown to the agent directly in the UI too
  (`#attachHint` next to the Upload button). If a customer needs larger files, both constants need
  raising together - check Catalyst's own untested Advanced I/O request-body ceiling first, since
  that may be the real limit before 15MB ever matters.
- **Device-upload attachments: BUILT but BLOCKED, Aug 10, 2026 — do not tell a customer this
  works.** The widget's "Upload file…" button, the `fileUpload` Catalyst function, and the whole
  upload → WorkDrive → public URL pipeline are built, deployed to both environments, and the
  resulting URL is *proven* to serve byte-correct file content (verified via curl, independently,
  multiple times). **But a real send test showed the resulting media never reaches WhatsApp** — a
  message with `media.value` set to this URL was accepted by Engati's API (200, real `messageId`,
  no `errorCode`) and simply never arrived on the phone, while a plain-text message to the same
  number in the same test session delivered correctly. So free-text itself is fine; something
  about this specific URL is not acceptable to WhatsApp/Meta's own media fetcher even though any
  normal HTTP client handles it fine. Root cause not found yet — see the "CRITICAL" section in
  persistent memory (`workdrive-attachment-research-unfinished.md`) for the leading hypotheses
  (most likely: the unusually long/complex `?x-cli-msg=...` query string itself, or WorkDrive's
  CDN applying anti-hotlink/bot rules against non-browser fetchers). The paste-a-URL field is
  unaffected and still works standalone — this only blocks the new upload-from-device path.

  **UPDATE (Phase E investigation, this migration - see `~/.claude/plans/starry-swimming-wombat.md`):**
  a genuinely new, concrete, previously-undiagnosed bug was found by code review (not yet
  confirmed by a real send): `functions/fileUpload/index.js`'s dispatcher only ever routed a
  `GET` request to the `/media?id=<shortId>` proxy path; a `HEAD` request to the exact same URL
  fell through to the upload handler instead, which returned a `200`-wrapped
  `{statusCode:400, "filename and dataBase64 required"}` JSON error rather than real media
  headers. Many media-fetching clients issue a preliminary `HEAD` probe (checking
  `Content-Length`/`Content-Type` against platform size/type limits) before the real `GET` — if
  WhatsApp's business media fetcher does this, it would receive that nonsense JSON instead of
  valid headers and could reject the attachment silently and asynchronously, exactly matching the
  reported symptom (Engati's API accepts the send with a real `messageId`, but the media never
  arrives). **Fixed** in `fileUpload/index.js` (HEAD now routes to the same `streamMedia` path as
  GET, returning identical headers with no body) — **but this is "a" fix, not confirmed as "the"
  fix yet.** A temporary diagnostic function, `functions/mediaDiagnostic/`, was also added
  (logs every header/method a real test send's media fetch uses, serves a real tiny valid JPEG so
  delivery can genuinely succeed if this really was the cause) — deploy it, send a real
  AGENT_MESSAGE with `media.value` pointed at its URL, and check Catalyst's logs before trusting
  either the diagnosis or the fix. Delete `mediaDiagnostic` once the investigation concludes; it's
  scaffolding, not a shipped feature.

  **The underlying mechanism was verified end-to-end via curl (real upload, real link, real
  unauthenticated fetch) before writing any function code — not guessed:**

  1. **Upload**: `POST https://www.zohoapis.in/workdrive/api/v1/upload?filename=<name>&parent_id=<folder-id>&override-name-exist=true`,
     multipart body with a `content` field. Returns `resource_id`. `parent_id` for "My
     Folders" root is the user's *privatespace id* (`GET /workdrive/api/v1/users/{zuid}` →
     `relationships.privatespace`).
  2. **Create a public link**: `POST https://workdrive.zoho.in/api/v1/links` — **note the
     different host from step 1** (`workdrive.zoho.in`, not `www.zohoapis.in` — using the
     wrong host looks exactly like a payload bug, it just 500s with no useful message). Body:
     ```json
     {"data":{"attributes":{"resource_id":"<from step 1>","link_name":"<label>",
       "password_text":"","expiration_date":"","request_user_data":false,
       "allow_download":true,"role_id":"34"},"type":"links"}}
     ```
     with `Accept: application/vnd.api+json` and `Content-Type: application/vnd.api+json`.
     **All of `password_text`/`expiration_date`/`request_user_data` must be present even when
     empty** — omitting any one produces the same generic `500 Servlet execution threw an
     exception` as using the wrong host, so a 500 here doesn't tell you which mistake you
     made. Response includes the link's own id at `data.id` — needed for step 3.
  3. **The actual raw-bytes URL** — construct:
     `https://files-accl.zohoexternal.in/public/workdrive-external/download/<resource_id>?x-cli-msg={"linkId":"<data.id>","isFileOwner":false,"version":"1.0","isWDSupport":false}`
     (JSON value URL-encoded). Confirmed stateless — no cookies, no auth headers — returns the
     file's raw bytes with correct `Content-Type` and `Content-Disposition`. **This is the
     only URL form that works** for WhatsApp/Meta's fetcher (a single plain GET, no
     JS/cookies).

  **What does NOT work, confirmed by testing — don't try these again:**
  - The plain share-link a human gets from "Copy link"
    (`https://workdrive.zohoexternal.in/external/<token>`), with or without
    `?directDownload=true` appended, returns an HTML/JS single-page-app shell, not the file.
    This directly contradicts what third-party blog posts claim — do not rely on that pattern.
  - The `download_url` field also present in the step-2 response is the same HTML shell, not
    raw bytes.

  Full detail, including the header-interception technique that found the real payload
  (blind trial-and-error against this undocumented endpoint burned significant time first),
  is in persistent memory (`workdrive-attachment-research-unfinished.md`).
- **Free-text messaging: RESOLVED Aug 10, 2026** (Engati ticket **ES-58715**). Root cause was
  ours, not Engati's: `botIdentifier` was wired to `ENGATI_CUSTOMER_ID`, which is the wrong
  value for that field. Fixed - see the `ENGATI_LIVECHAT_BOT_IDENTIFIER` callout above. Confirmed
  delivering end-to-end through the actual widget, not just a direct API call.
