# Per-invocation router replies

This local continuation of `8503f773bdb27b80280952c3ef9d4c9f4df50ad5` resolves
the router-path blocker described in the retained v151 completion document.
`SessionRouter.routeAndHandle` accepts an optional reply effect and carries it
through routing, handler timeout and the private reply helper. The index caller
closes that effect over its immutable completion scope and the existing
`sendMessage` interface. No mutable router state, last caller, prototype override,
alternate router, verifier or authority source is added. Unbound callers retain
the original direct-send behavior and swallowed-reply-error contract.

Router timeout/rate-limit/oversize replies use the existing completion `notice`
operation, including its cancellation signal, generation check, underlying effect
collection and finite 30-second notice budget. A dispatch apology does not start
the final reply's absolute 60-second delivery budget and does not cancel an
accepted model turn. Rejection/timeout does not fall back to the default sender,
retry the reply, clear a mapping, or execute fresh model work.

The before-write inert API capture honors the existing send API's AbortSignal
contract. The original v151 capture ignored cancellation while held; it is
retained unchanged as parent evidence. Its original security assertion is
unchanged. A matching abort-aware parent control still fails before the product
correction and succeeds afterward, proving that the capture adjustment cannot
hide an absent reply binding. Already-accepted remote effects are a separate
unknown outcome: cancellation cannot retract them. An uncooperative late response
remains owned, is never resent, writes no successful assistant history, and
prevents DB/lease release until collection. These direct sends are not unified
OctoEgress and do not add an outbound primitive.

Actual guarded index/router/HostCaller cases cover before-write reset/shutdown,
queued caller cancellation, different session/bot isolation, callback rejection
and timeout, unbound defaults and an ordinary dispatch apology while the accepted
turn continues. Both pinned runtimes and injectable executors are used offline.
Existing delayed history ordering, F1, rollback, native generation/DB/lease
collection and strict provenance controls remain required affected regressions.

There is still no production persistent reset-generation/CAS producer. Trusted
generation changes in the fixture model an already committed injected test hook;
reset/new controls continue typed NO-WRITES before legacy mutation. Production
issuer/authority/mandatory-effects, real activation, cron producer/finalization
and full egress remain prerequisites. Six inherited C1 failures/runtime and
historical failures are not edited, rerun as a full corpus or relabeled green.
