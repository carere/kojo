# Local Daemon transport and browser access

## Question

Which transport and browser security facts constrain local CLI and Console access to one Daemon
per OS user?

Checked on 2026-08-31. This note supplies evidence for
[Define local Daemon transport and client access](https://github.com/carere/kojo/issues/58#issuecomment-5472537079).
The selected contract lives in that decision ticket. This note records facts and their limits;
it does not claim that the selected contract is implemented. No product code was changed.

## Bun transport support

Bun supports HTTP over a pathname Unix domain socket with `Bun.serve({ unix: path, fetch })`.
Bun's `fetch(url, { unix: path })` can call that server. A native Bun CLI can therefore use HTTP
semantics without a TCP listener. Browser Fetch does not expose this Bun extension. See
[Bun server configuration](https://bun.com/docs/runtime/http/server#unix-domain-sockets) and
[Bun Unix socket Fetch](https://bun.com/guides/http/fetch-unix).

For TCP, `port: 0` asks Bun to select an available port. The bound port is available through
`server.port` and `server.url`. The default hostname is `0.0.0.0`, so a local listener must set an
explicit loopback address. `server.requestIP()` returns IP and port information for TCP, and `null`
for a Unix socket; it is not an OS-user credential API. See
[Bun server configuration](https://bun.com/docs/runtime/http/server).

A temporary probe on this host used the repo's pinned Bun 1.3.14. It created a private temporary
directory, served HTTP on its pathname socket, and served HTTP on `127.0.0.1` with `port: 0`.
Both Fetch calls returned their expected response; the TCP hostname was `127.0.0.1` and the
assigned port was nonzero. The probe stopped both servers and removed the directory. This verifies
the two primitives on this macOS host, not Linux behavior or a complete client adapter.

## A local address does not identify an OS user

Loopback confines traffic to the device. It does not identify the caller's OS account. RFC 8252
explicitly describes other applications on the same device accessing the loopback interface and
intercepting loopback redirects. Its permission to use HTTP concerns local OAuth redirects; it
does not establish a general security contract for a long-running Daemon API. See
[RFC 8252, sections 7.3, 8.1, and 8.3](https://www.rfc-editor.org/rfc/rfc8252).

On Linux, pathname sockets obey directory permissions, and connection to a stream socket needs
write permission on the socket. Socket-file permission behavior is not portable across all Unix
systems. Linux abstract sockets have no filesystem permission boundary. Linux supplies
`SO_PEERCRED` for peer credentials, but that does not prove Bun's HTTP handler exposes them. See
[Linux unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html).

**Inference for Kojo:** a private socket directory or an application credential can form part of
the per-user access boundary. A loopback IP address, guessed port, or browser header cannot replace
that boundary. A user-only file also does not isolate Kojo from other processes with that same
user's file access, or from an administrator.

## Browser request checks

An origin consists of scheme, host, and port. The same-origin policy limits cross-origin reads,
but permits many cross-origin writes, such as form submissions. Thus, absence of permissive CORS
headers does not by itself prevent a browser from sending a state-changing request. See
[MDN same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy).

OWASP documents exact source-origin checks and CSRF tokens. It also permits custom request headers
for APIs when a strict CORS policy prevents untrusted sites from passing the preflight. Tokens must
be unpredictable, secret, and checked on the server. Safe HTTP methods must not change state.
Origin checks need a defined policy for missing headers; `Origin: null` is not a trusted origin.
These browser protections are separate from authentication. See
[OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

Host validation addresses a different route to the same local listener: a hostile domain can
resolve to loopback. The MCP Ruby SDK maintainers document a local-server vulnerability caused by
missing Host and Origin checks. Their fix uses explicit allowlists. This is evidence for the
attack mechanism, not a requirement to use MCP. See the
[maintainer security advisory](https://github.com/modelcontextprotocol/ruby-sdk/security/advisories/GHSA-rjr6-rcgv-9m7m).

**Inference for Kojo:** browser API checks must use the expected bound origin, not accept an
arbitrary Origin merely because it matches the request's unvalidated Host. A CLI can set its own
headers, so Host and Origin checks cannot authenticate that CLI. A separate CLI transport can have
its own request policy without weakening the Console policy.

## Cookies and port reuse

Cookies do not isolate services by port. RFC 6265 warns against storing sensitive cookies when
mutually distrusting services run on different ports of the same host. A cookie path is not a
security boundary either. A different localhost port can be a different browser origin while
still receiving applicable cookies. See
[RFC 6265, sections 8.5 and 8.6](https://www.rfc-editor.org/rfc/rfc6265).

**Inference for Kojo:** a random port is endpoint allocation, not authentication. A stale discovery
record or bookmark can point to a different listener after the Daemon stops. A new port after
restart also changes the Console origin. Discovery, reconnect behavior, session storage, and
credential scope must account for both cases. A per-start random port does not repair cookie scope.

## Bootstrap secrets and listener identity

Bearer credentials grant authority to their holder. RFC 6750 warns against page URLs because URLs
can enter browser history and logs; it recommends headers or message bodies and short credential
lifetimes. This general leakage evidence does not make Kojo an OAuth system. See
[RFC 6750, sections 2.3 and 5.3](https://www.rfc-editor.org/rfc/rfc6750).

A URL fragment is not sent in the HTTP request. It is available to the page after retrieval.
`history.replaceState()` can replace the current history entry without navigation. See
[MDN URI fragments](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment) and
[MDN replaceState](https://developer.mozilla.org/en-US/docs/Web/API/History/replaceState).

**Inference for Kojo:** a fragment can reduce HTTP URL leakage, but it is not a private channel to
the intended Daemon. If another process owns a reused port, its page can read the fragment. A
trusted CLI reading discovery over a private socket does not, by itself, prove which server the
browser later reaches. A bootstrap design must address this gap or state it as a threat-model
limit. One-use and short-lived secrets limit reuse but do not prove listener identity. Do not
assume that removing a fragment erases prior logs, clipboard copies, launcher arguments, or browser
access to the original URL.

## Untrusted HTML Artifacts

An iframe sandbox without `allow-same-origin` gives the document an opaque origin. For content
served from the Console origin, adding both `allow-scripts` and `allow-same-origin` can let the
content remove the iframe sandbox. An iframe-only restriction also does not protect direct
navigation to the same content. See
[MDN iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe).

The response header `Content-Security-Policy: sandbox` applies restrictions to the resource itself.
Without `allow-same-origin`, its origin is opaque and its Origin header is `null`. The directive
does not work in a meta element or a report-only policy. See
[MDN CSP sandbox](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox).

**Inference for Kojo:** an HTML Artifact cannot receive the same script authority as the Console.
An Artifact needs an isolation policy that also holds on direct navigation. A separate port gives
origin separation but does not give cookie separation. The API must not treat the Artifact's
opaque origin as trusted. The final preview policy must separately decide scripts, forms,
navigation, downloads, and network access; an opaque origin alone does not disable all requests.

## Browser API details

Browser Fetch accepts request headers, including `Authorization`, which is not a forbidden request
header. It exposes the response body as a `ReadableStream`; the caller can decode and process bytes
as they arrive. The standard `EventSource` constructor has a URL and a `withCredentials` option,
but no custom-header option. Thus, **as an API capability inference**, a Fetch-based client can send
an Authorization header and read SSE-framed bytes, but must supply the event parser and reconnect
logic itself. Fetch does not add EventSource behavior merely because the response is an event
stream. See [MDN Fetch](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch),
[MDN Authorization](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Authorization),
and [MDN EventSource constructor](https://developer.mozilla.org/en-US/docs/Web/API/EventSource/EventSource).

`sessionStorage` is partitioned by origin and browser tab. It survives reloads and restores within
the page session; closing the tab ends that session. A page with an opener can receive an initial
copy of the opener's session storage. `localStorage` is scoped to the origin and persists across
browser sessions without an automatic expiration time. Neither is inaccessible to scripts of that
origin. These are storage facts, not a guarantee of credential expiry on the Daemon. See
[MDN sessionStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage) and
[MDN localStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage).

Browsers generally omit Origin on same-origin `GET` and `HEAD`, and send it on same-origin `POST`,
`PUT`, `PATCH`, and `DELETE`. Some cross-origin requests also omit it, and some contexts produce
`Origin: null`. Therefore, **as an implementation constraint**, missing Origin alone cannot classify
a request as hostile or identify it as a CLI request. Rejecting every browser read with no Origin
would reject normal same-origin Fetch reads. Request authentication and the policy for safe reads
must remain distinct from the policy for state changes. See
[MDN Origin](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Origin).

## Limits

This research did not test browser interoperability, a bootstrap handshake, Linux permissions,
peer-credential bindings, browser storage behavior after restart, or streamed client reconnects.
The transport probe verifies capability only. The selected discovery, authentication, expiry,
compatibility, and Artifact rules require implementation and verification under the decision
ticket's contract.
