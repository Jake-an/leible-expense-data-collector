# TODO — BrightHR Payroll Automation

## Done — at a glance
- Project scaffolded (git, gitignore, CLAUDE.md, env template)

## Active

### Phase 1 — Map the click-path (Claude drives the browser)
- [ ] Confirm authorization + whether login has MFA/CAPTCHA
- [ ] Get credentials in safely (Jake types password in browser, or .env)
- [ ] Log in to app.brighthr.com.au
- [ ] Find the reports / payroll roster section
- [ ] Select date range
- [ ] Trigger + verify the download
- [ ] Record exact steps in `docs/clickpath.md`

### Phase 2 — Port to OpenClaw (later)
- [ ] Enable a browser tool in the OpenClaw Gateway
- [ ] Grant the agent permission to use it
- [ ] Write the BrightHR skill from docs/clickpath.md
- [ ] Test unattended run via the daemon
