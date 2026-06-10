export const URI = "avocado://skills/avocado-connect";
export const NAME = "avocado-connect";
export const DESCRIPTION =
  "Avocado Connect: the OTA fleet management platform. Auth flow, project init, the upload → publish → deploy lifecycle, claim tokens for device enrollment, and CLI command reference. Read this before using any `connect-*` MCP tool or running any `avocado connect` command.";

export const CONTENT = `# Avocado Connect

Avocado Connect is the OTA fleet management platform — it lets you push runtime updates to a fleet of enrolled devices without physical access. Backed by Peridio's device management infrastructure.

## Concepts

| Term | Meaning |
|------|---------|
| **Organization** | A tenant on the Connect platform. Maps to a Peridio org. |
| **Project** | A logical grouping for a fleet of devices building the same product. Linked to an \`avocado.yaml\` project via \`avocado connect init\`. |
| **Runtime** | An uploaded build artifact — the output of \`avocado connect upload\`. Versioned. Can be in draft, published, or archived state. |
| **Cohort** | A group of devices in a project. Deployments target cohorts, not individual devices. |
| **Deployment** | An instruction to push a specific runtime to a cohort. Can be in draft (staged), active (rolling out), or archived state. |
| **Claim token** | A one-time credential devices use at first boot to self-enroll into a cohort. |
| **Connect extensions** | Two extensions \`connect-config\` + the runtime's config overlay that \`connect init\` adds to your \`avocado.yaml\` runtime. They configure TUF, the Connect agent, and the update scheduler on the device. |

## Auth flow

\`\`\`bash
avocado connect auth login             # opens browser, writes ~/.avocado/credentials.json
avocado connect auth status --output json  # verify: { "logged_in": true, "token_valid": true, ... }
avocado connect auth logout
\`\`\`

Credentials are stored in \`~/.avocado/credentials.json\`. The Desktop app watches this file and reflects the login state in the UI automatically.

## Project initialization (one-time per project)

\`avocado connect init\` links your local project to a Connect project and adds the OTA plumbing to your \`avocado.yaml\`:

\`\`\`bash
avocado connect init \\
  --org <org-id> \\
  --project <project-id> \\
  --cohort <cohort-id> \\          # optional — prompts if multiple exist
  -r dev \\                         # which avocado.yaml runtime to wire
  -C avocado.yaml \\
  --output json                    # non-interactive (required for MCP/Desktop)
\`\`\`

What it does:
1. Adds a \`connect:\` section to \`avocado.yaml\` with your org + project IDs.
2. Adds the \`connect-config\` extension to your runtime (installs the Connect agent + TUF client).
3. Creates a device config overlay with your cohort's enrollment parameters.
4. Writes an initial \`connect/\` directory in the project with config files.

Run \`avocado connect orgs list --output json\` → pick an org → \`avocado connect projects list --org <id> --output json\` → pick a project → \`avocado connect cohorts list --org <id> --project <id> --output json\` → pick a cohort.

## Upload → Publish → Deploy lifecycle

\`\`\`bash
# 1. Build first (the runtime artifact must be current)
avocado build -C avocado.yaml --target <target> --output json

# 2. Upload the built artifact to the platform (creates a runtime in draft)
avocado connect upload dev \\       # runtime name (positional arg)
  --version v0.0.2-dev \\          # REQUIRED: human-readable version for this upload
  -C avocado.yaml \\
  --publish \\                      # promote to "published" immediately
  --deploy-cohort <cohort-id> \\   # optionally deploy right after upload
  --deploy-activate \\             # activate the deployment (rolls to devices)
  --output json                   # NDJSON: task_registered/step per phase → artifact_uploaded → complete (error event on failure)

# 3. (Or deploy separately if upload was done without --deploy-cohort)
avocado connect deploy \\
  --runtime <runtime-id> \\
  --cohort <cohort-id> \\
  --activate \\                    # make it active immediately
  -C avocado.yaml \\
  --output json                   # NDJSON: task_registered/step (resolve → create-deployment → activate) → complete (error event on failure)
\`\`\`

**Key rules:**
- The runtime must be **published** (not draft) before it can be deployed to a cohort.
- \`--publish\` during upload promotes draft → published in one step.
- \`--activate\` during deploy activates the deployment immediately (devices start pulling the update).
- Without \`--activate\`, the deployment is created in draft — useful for staged rollouts.

## List commands (all support --output json)

\`\`\`bash
avocado connect orgs list --output json
avocado connect projects list --org <id> --output json
avocado connect cohorts list --org <id> --project <id> --output json
avocado connect runtimes list --org <id> --project <id> --output json
avocado connect devices list --org <id> --project <id> --output json
avocado connect claim-tokens list --org <id> --output json
\`\`\`

## Claim tokens (device enrollment)

Devices enroll at first boot using a claim token. The token is baked into the device image via the connect-config extension. Generate / rotate via:

\`\`\`bash
avocado connect claim-tokens list --org <id> --output json
\`\`\`

## Undoing Connect (clean)

\`avocado connect clean\` removes the \`connect:\` block, the connect-config extension, and the device config overlay from your \`avocado.yaml\`. Use before re-initializing with different settings.

\`\`\`bash
avocado connect clean -r dev -C avocado.yaml --output json
\`\`\`

## MCP tool order for \`/setup-connect\`

1. \`connect-auth-status\` — confirm logged in + token valid.
2. \`connect-list-resources\` \`{ resource: "orgs" }\` — list orgs.
3. Ask user which org (or auto-select if only one).
4. \`connect-list-resources\` \`{ resource: "projects", org: "<id>" }\` — list projects.
5. Ask user which project (or auto-select if only one).
6. \`connect-list-resources\` \`{ resource: "cohorts", org: "<id>", project: "<id>" }\` — list cohorts.
7. Ask user which cohort (or auto-select if only one).
8. \`connect-init\` — run init with the selections.
9. Instruct user to rebuild (\`avocado build\`) so the new connect-config extension is included.
`;
