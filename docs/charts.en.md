# Architecture Charts (English)

> Three charts: ① simplified data flow (PPT-level) ② network architecture ③ end-to-end sequence.
> Spec source: `docs/design/fde-platform.md`; for topology details defer to `docs/design/topology.md`.
> Chinese version: [`charts.zh.md`](charts.zh.md).

---

## Chart 1 · Simplified Data Flow (PPT-level)

```mermaid
flowchart LR
    BR["FDE Browser"]
    TR["Traefik<br/>the only ingress"]
    PO["Portal<br/>control plane"]
    DB[("DB<br/>source of truth")]
    FC["FDE Container<br/>pi agent"]
    LG["LLM Gateway"]
    UP["Upstream LLM"]

    BR -- "① login / chat / preview" --> TR
    TR -- "② routing + edge auth" --> PO
    PO -- "③ persist" --> DB
    TR <-- "④ outbound channel: event reporting / SSE dispatch" --> FC
    FC -- "⑤ LLM request (zero credentials)" --> TR
    TR -- "⑥ inject key by source subnet" --> LG
    LG -- "⑦ forward" --> UP
```

### Key points

- **Six actors**: browser, Traefik, Portal, DB, FDE container, LLM gateway — every line connects only these
- **All traffic goes through Traefik**: browser, containers, LLM alike; "not in the route table = unreachable"
- **Portal is the sole DB writer**: containers never touch the DB; events/state land via the internal API through portal
- **Containers are outbound-only**: zero listeners, zero platform secrets (only a per-container token); dispatch arrives over SSE downlink
- **LLM credentials are injected at the edge**: containers hold only a placeholder key; the real virtual key is override-injected by Traefik based on source subnet

---

## Chart 2 · Network Architecture

```mermaid
flowchart TB
    subgraph ext["External"]
        BR2["FDE browsers"]
        UP2["Upstream LLM providers"]
        GIT["git hosts (GitHub/Gitea)"]
    end

    TRA["station-edge (Traefik)<br/>host network, exclusive 80/443<br/>TLS · host-based routing · forwardAuth<br/>LLM credential injection by source subnet"]

    subgraph backend["backend network 172.30.0.0/24"]
        POR["station-portal :8080<br/>publishes only 127.0.0.1<br/>the only container with docker.sock"]
        DB2[("station-db (Postgres)<br/>source of truth: users/sessions/transcripts<br/>events/ports/usage/audit")]
        LLM["llm-gateway (LiteLLM etc.)<br/>the only LLM egress<br/>data plane loopback :4000 · admin not published"]
    end

    subgraph fdeA["fde-alice (10.200.1.0/29, exclusive)"]
        AGD["station-agentd<br/>outbound daemon · per-container token<br/>SSE downlink: dispatch / approval / stop"]
        RUN["station-runner (one per run)<br/>pi agent — runToolLoop<br/>TranscriptStore = HTTP adapter"]
        CS["code-server :3001<br/>dev servers :4000+<br/>workspace volume"]
    end

    subgraph fdeB["fde-bob (10.200.2.0/29, exclusive)"]
        AGD2["station-agentd + runner<br/>(pi agent)"]
    end

    REC["reconciler<br/>idempotent Traefik config publisher (mode 600)"]
    DOCK["docker daemon"]
    BLOCK["Cross-FDE direct access<br/>blocked by DOCKER-ISOLATION"]
    EGRESS["Security-team network-layer egress policy<br/>deny by default · allowlist (npm/pypi/git etc.)<br/>LLM domains NOT on it = the gateway is the only LLM exit"]

    BR2 --> TRA
    TRA -- "portal UI: station.example.com" --> POR
    TRA -- "preview/IDE: *.fde.example.com<br/>forwardAuth, then direct to container IP" --> CS

    AGD -- "internal API via Traefik<br/>ipAllowList (FDE subnets only)" --> POR
    RUN --> AGD
    RUN -- "LLM: llm.example.com<br/>placeholder key only" --> TRA
    TRA -- "identity = ClientIP subnet<br/>injects real virtual key" --> LLM
    LLM --> UP2

    POR -- "create/manage containers & /29 networks" --> DOCK
    DOCK -.-> fdeA
    DOCK -.-> fdeB
    POR -- "DB tx: port_allocations + route outbox" --> DB2
    POR --> REC --> TRA
    POR -- "materialize user space<br/>/srv/erix/users/<fde> → HOME" --> CS
    RUN -.-> GIT
    RUN -. "non-allowlisted destinations: unreachable at network layer" .-> EGRESS
```

### Key points

- **Traefik runs on the host network**: reaches every `/29` with zero docker network attachment; `--api=false`, admin surface fully closed
  > `api` refers to Traefik's built-in REST API + Dashboard (`api@internal` routers). When enabled, `/api/http/routers|services|middlewares` return the full effective configuration: every router rule, every service backend address, every middleware definition — i.e. all FDE container IPs, port allocations, preview hostnames, plus the exact CIDRs of the internal `ipAllowList` and the existence pattern of LLM credential-injection middlewares. In this architecture FDE containers are unavoidable Traefik clients holding root: enabling the API hands any compromised container the full platform recon dataset for lateral movement. Hence `api: false` is written explicitly in static config (not left to the default) and listed in the hardening checklist with an acceptance item: the closed admin surface is an immutable ingress property, not an ops habit
- **backend (172.30.0.0/24)**: portal + DB + LLM gateway; portal publishes only loopback `127.0.0.1:8080`
- **One exclusive `/29` per FDE**: `fde-alice` / `fde-bob` cannot reach each other; isolation is guaranteed by topology (DOCKER-ISOLATION), zero configuration
- **Container → portal is outbound-only, via Traefik**: ipAllowList derived precisely from `fde_networks`, then looped back to portal
- **LLM identity = source subnet**: Traefik's `ClientIP` match triggers Authorization override-injection; no matching source → 404 = deny by default
- **Portal is the sole control-plane writer**: only container with docker.sock; port allocation + route outbox written in one DB tx, reconciler publishes routes idempotently

### Why the network is designed this way (security rationale)

> Full argument in `topology.md` (§6 hardening checklist, §7 connectivity matrix, §8 residual risk); design motivations only here.

- **Controlled egress (not free internet access)**: FDE containers have a shell — file permissions can't stop them from editing configs; **the only effective guarantee is "the network cannot reach it"**. The egress allowlist is enforced at the network layer by the security team; LLM domains are **not** on the allowlist → the gateway is the only reachable LLM exit, so changing endpoint/key is pointless
- **LLM calls require no key inside the container**: containers hold **zero LLM credentials** — their config contains only a placeholder key plus `endpoint=llm.example.com`; the real virtual key lives solely in the host's Traefik dynamic config (mode 600, writable only by portal, read-only for Traefik). As a request crosses the edge, identity is determined by **source subnet** and `Authorization` is **override-injected** (any key the container presents is overwritten). Security value: even a fully compromised container (root included) yields **no LLM credentials at all**; keys never touch container disks or env vars, so there is no leakage surface to audit
- **FDEs cannot reach each other (no loss of control)**: shared networks are the root cause of lateral privilege escalation — the original shared `control` network was abolished for exactly this reason. Each FDE owns an exclusive `/29`; cross-bridge forwarding is dropped by DOCKER-ISOLATION — isolation with zero configuration and no workaround
- **Container → host services must be closed too**: it was measured that FDE containers could reach host gitea/mssql/portainer via the gateway IP — hence a **layered firewall** (INPUT for host-local services + DOCKER-USER for forwarding/publish), rules generated from precise CIDRs in `fde_networks`
- **Identity = network location**: both the internal API and LLM links authenticate by source subnet (ipAllowList / ClientIP), with credentials override-injected by Traefik — tokens can't be stolen, forged headers are killed by `aliasHeadersStrategy: delete` and "never read X-Forwarded-For"
- **Defense in depth**: topology isolation (unreachable) + edge auth (forwardAuth) — **both layers required, neither suffices alone**; containers are zero-listener with zero platform secrets → even if compromised, there are no credentials to steal and no inbound path to exploit
- **Residual risk, explicitly accepted**: FDEs are root inside their own container and can forge **their own** events/usage; cross-FDE is blocked by portal ownership checks (cannot affect others, cannot escalate to DB/LLM credentials) — a deliberate trade-off, not an oversight

---

## Chart 3 · End-to-End Sequence (what happens after an FDE opens the page)

```mermaid
sequenceDiagram
    autonumber
    actor A as Alice (FDE browser)
    participant T as Traefik<br/>(station-edge, :443)
    participant P as station-portal<br/>(127.0.0.1:8080)
    participant DB as station-db<br/>(Postgres)
    participant AG as station-agentd<br/>(inside fde-alice, outbound SSE)
    participant R as station-runner<br/>(pi agent, runToolLoop)
    participant G as llm-gateway<br/>(data plane :4000)
    participant U as Upstream LLM

    rect rgb(240, 244, 255)
    Note over A,DB: Phase 0 — onboarding (done long ago, shown as context)
    Note over P,DB: create user · allocate /29 · start container<br/>write port allocation + routes · create virtual key (Traefik config only)<br/>materialize /srv/erix/users/alice → HOME
    end

    rect rgb(240, 255, 240)
    Note over A,P: Phase 1 — open the page and log in
    A->>T: GET station.example.com
    T->>P: route to portal
    P-->>A: 302 → corporate SSO (OIDC)<br/>issue host-only session cookie
    end

    rect rgb(255, 250, 235)
    Note over A,R: Phase 2 — send a task "add an export button" → dispatch
    A->>T: POST message
    T->>P: persist messages
    P->>DB: INSERT messages · INSERT runs · enqueue run_queue
    P--)AG: SSE downlink: dispatch hint (agentd idles on this long-lived connection)
    AG->>P: claim (lease 90s) + heartbeat every 15s<br/>Authorization: Bearer per-container token
    AG->>R: spawn subprocess · create worktree agent/runId
    end

    rect rgb(255, 240, 240)
    Note over R,U: Phase 3 — pi agent works (LLM + tools + reporting)
    loop each round
        R->>T: LLM request → llm.example.com/v1 (placeholder key)
        T->>G: ClientIP(10.200.1.0/29) determines identity<br/>override-inject Alice's virtual key → loopback 127.0.0.1:4000
        G->>U: forward upstream
        U-->>R: streaming completion back
        R->>R: run tools: edit code / run tests / start dev server :4000<br/>(binds 0.0.0.0, port taken from ports.json)
        AG->>T: POST /api/internal/* (transcript / events / checkpoint)
        T->>P: ipAllowList source filter (FDE subnets) → loopback to portal
        P->>DB: persist events + seq allocation + usage_ledger accounting
    end
    end

    rect rgb(245, 240, 255)
    Note over A,DB: Phase 4 — the live stream back to her screen
    P-->>A: SSE pushes run_events (by seq, resumable after disconnect)<br/>chat page streams tool_use / deltas in real time
    end

    rect rgb(235, 250, 255)
    Note over A,R: Phase 5 — preview the result
    A->>T: GET alice-p-proj1-4000.fde.example.com
    T->>P: forwardAuth (checks preview_grants + exposure)
    P-->>T: 200 pass (first pass: allocation → active)
    T->>R: strip-cookie, then direct to container IP 10.200.1.2:4000
    R-->>A: dev server page (in iframe, zero modification)
    end

    rect rgb(245, 255, 245)
    Note over A,DB: Phase 6 — run wrap-up
    R->>AG: U2 terminal state (termination / usage / final_text)
    AG->>P: report
    P->>DB: synthesize run_end · usage booked (single source of truth)
    Note over P: run-level ports recycled · worktree kept<br/>after review: fork/PR back (git-host-neutral, handled by the FDE)
    end
```

### Key points

- **Phase 1 — auth entirely at the edge**: SSO/OIDC + session cookie; applications never handle authentication themselves
- **Phase 2 — portal never connects to containers**: the dispatch hint rides the existing SSE long connection; agentd claims outbound (lease + heartbeat)
- **Phase 3 — the heart of the system**: LLM identity from the source subnet, state via outbound reporting into the DB — containers stay zero-listener, zero-secrets, DB-blind
- **Phase 4 — events persist first, then stream**: portal restarts don't kill tasks; multi-device sync; resumable by seq after disconnect
- **Phase 5 — preview with zero modification**: forwardAuth edge authorization + strip-cookie; the dev server never knows
- **Phase 6 — single source of truth for accounting**: `run_end` is synthesized by portal; usage from terminal-state reporting, reconciled with gateway usage periodically

---

## Mechanism Deep-Dive · The Preview Access Chain (port allocation → edge auth → container)

> Spec refs: `fde-platform.md` §8 / §5.3 / §6, `topology.md` §4-L2, `portal.md` §2.7–2.8. This mechanism simultaneously achieves "users open a preview like any normal website" and "containers have zero inbound, zero published ports, and cannot self-register routes".

```mermaid
flowchart TB
    subgraph alloc["Allocation time (project creation: one DB tx, fully automatic in seconds)"]
        A["POST /api/projects"] --> B[("DB tx<br/>port_allocations + route outbox<br/>hostname generated mechanically by grammar, never rewritten")]
        B --> C["reconciler publishes idempotently"]
        C --> D["Traefik dynamic config (mode 600)<br/>router: Host(alice-p-proj1-4000.fde...)<br/>service: http://10.200.1.2:4000"]
        B --> E["materialize ports.json into container<br/>(port + ready-made URL, agent read-only)"]
    end

    subgraph access["Access time (every request)"]
        BR2["Browser<br/>https://alice-p-proj1-4000.fde.erix.vip"] --> T2["Traefik :443<br/>TLS terminated with wildcard cert"]
        T2 --> FA["forwardAuth → portal<br/>hostname → allocation lookup → preview_grants<br/>→ fde_id + exposure check (every decision writes audit_log)"]
        FA -- "pass (first pass: allocated → active)" --> SC["strip-cookie<br/>preview credentials never reach the upstream"]
        SC --> IP["direct to container IP :4000<br/>dev server zero-modification, plain HTTP all the way"]
    end
```

### Why it is elegant (five points)

- **DB is the truth, routes are its shadow**: allocation, reconfiguration, and recycling are all DB operations; the three derived artifacts (Traefik config, ports.json in the container, the URL) stay in sync automatically — there is no "manual sync" step and no "FDE self-registers a route" opening. **Not in the route table = unreachable** is a verifiable security property
- **Domains are dynamically obtained but not freely chosen**: the hostname is generated mechanically by the grammar (fde + project name + port) — free-form hostnames are deliberately forbidden, otherwise the property above could be bypassed by "naming my own service"; wildcard DNS + wildcard cert mean every new allocation requires **zero DNS/certificate work**
- **Auth entirely at the edge, dev servers zero-modification**: the agent's app adds no login, no TLS, no CORS; forwardAuth decides in the Traefik middleware layer, and the credential system (one-time ticket → host-only preview cookie) is isolated from the portal login state — forwarding the link to someone else = 401
- **Encryption responsibility concentrated in one place**: plain HTTP inside the container (the native form of dev servers), TLS seamlessly taken over by Traefik; plaintext exists only inside the single-FDE exclusive `/29` — no man-in-the-middle position exists
- **Listen surface equals reachable surface exactly**: the dev server binds 0.0.0.0 (against convention) only because its sole client is the host's Traefik; ports are not published and cross-FDE traffic is dropped by DOCKER-ISOLATION — the actual reachable range of "listening on 0.0.0.0" collapses to a single point at the edge
