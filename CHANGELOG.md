# Changelog
All notable changes to this project will be documented in this file. See [conventional commits](https://www.conventionalcommits.org/) for commit guidelines.

- - -
## v0.1.0-alpha.1 - 2026-09-06
### Package updates
- kojo-client-contracts bumped to kojo-client-contracts@v0.1.0-alpha.1
- kojo-runner-contracts bumped to kojo-runner-contracts@v0.1.0-alpha.1
- kojo bumped to kojo@v0.1.0-alpha.1
- kojo-runtime bumped to kojo-runtime@v0.1.0-alpha.1
### Global changes
#### Features
- (**agent**) refuse an agent call no one authorised, in the invoker - (bae2d21) - Kojo, *Claude Opus 5*
- (**console**) focus phase details on user-facing facts - (e9cc59a) - Kojo
- (**console**) fill the card with the timeline, and zoom it with the wheel - (105b643) - Kojo, *Claude Opus 5*
- (**release**) publish npm and JSR from GitHub Actions (#95) - (80fcd68) - Kevin Abatan
- (**release**) add staged release train - (99e13f8) - Kevin Abatan
- <span style="background-color: #d73a49; color: white; padding: 2px 6px; border-radius: 3px; font-weight: bold; font-size: 0.85em;">BREAKING</span>(**release**) publish as @carere/kojo, and make the tarball right - (6f51443) - Kojo, *Claude Opus 5*
- (**sandbox**) hide the factory's own paths from the agent that runs in it - (1ac49be) - Kojo, *Claude Opus 5*
- (**sandbox**) take the factory's own paths out of the tree an agent works in - (5bf4368) - Kojo, *Claude Opus 5*
- (**scaffold**) route Kojo skill by task - (07c4e48) - Kevin Abatan, *Kojo Test*
- (**scaffold**) tell an author which of their rules the agent never sees - (148bf90) - Kojo, *Claude Opus 5*
- (**workflow**) tell a model a literal field must equal one of the words - (846a59e) - Kojo, *Claude Opus 5*
- (**workflow**) say a literal field must equal one of its words - (a014606) - Kojo, *Claude Opus 5*
- add one Kojo daemon per OS user - (2189abc) - Kevin Abatan, *Kojo*
#### Bug Fixes
- (**agent**) put the spend guard on the thing that spawns, not only on the invoker - (4599717) - Kojo, *Claude Opus 5*
- (**agent**) read the layout pi actually writes, not the one Kojo assumed - (d67b135) - Kojo, *Claude Opus 5*
- (**console**) call the idempotency key what it is - (c99a0cd) - Kojo, *Claude Opus 5*
- (**console**) name each fact in the run header - (d719a47) - Kojo, *Claude Opus 5*
- (**console**) state a long wait in days, weeks or years - (ee749eb) - Kojo, *Claude Opus 5*
- (**console**) stop a live run rebuilding its whole timeline every second - (54addab) - Kojo, *Claude Opus 5*
- (**console**) stop the axis smearing, and make the detail card readable - (0d8371a) - Kojo, *Claude Opus 5*
- (**console**) make the timeline readable, and say why a run failed - (90a0245) - Kojo, *Claude Opus 5*
- (**repo**) give the root package its own name, and pin the toolchain - (623f0f9) - Kojo, *Claude Opus 5*
- (**sandbox**) never release a worktree git cannot answer about - (548e58e) - Kojo, *Claude Opus 5*
- (**tests**) let a fixture name its own trunk instead of inheriting one - (b7958cd) - Kojo, *Claude Opus 5*
- (**tests**) stop two fixtures passing on this machine's configuration - (10bec68) - Kojo, *Claude Opus 5*
- remove obsolete code and close alpha release gaps - (883f2e6) - Kevin Abatan
#### Documentation
- (**53**) correct two claims the adversarial pass refuted - (1479c83) - Kojo, *Claude Opus 5*
- (**54**) close the ticket the previous commit said was closed - (d23715f) - Kojo, *Claude Opus 5*
- (**62**) the passing run refuted this ticket's own reading - (787a4dc) - Kojo, *Claude Opus 5*
- (**62**) add the observation the previous commit described - (e1c369c) - Kojo, *Claude Opus 5*
- (**agent**) assign spending control to workflow authors - (e17638a) - Kojo
- (**build-record**) record the stage that closed the tracker - (f8aadd0) - Kojo, *Claude Opus 5*
- (**cli**) settle workflow activity and archive terms - (6f37d0e) - Kojo
- (**context**) define runner recovery and cancellation - (8063bab) - Kojo
- (**context**) define runner and trigger ownership - (ef14aee) - Kojo
- (**context**) qualify cross-project identities - (f130507) - Kojo
- (**daemon**) define context and port boundaries - (341e4d1) - Kojo
- (**daemon**) define local client access contract - (6bb91b3) - Kojo
- (**project**) define daemon upgrade lifecycle terms - (5dd680e) - Kojo
- (**project**) define project execution package - (e5dda18) - Kojo
- (**project**) define daemon drain - (53033b6) - Kojo
- (**project**) define project identity lifecycle - (b589230) - Kojo
- (**project**) define daemon data ownership - (9ba559d) - Kojo
- (**research**) document per-user daemon lifecycle - (34b4fa7) - Kojo
- (**tickets**) open 56 for the two kojoPi faults ticket 52 measured - (e0715c1) - Kojo, *Claude Opus 5*
- (**tickets**) open 54 and 55, both found by the wave rather than planned - (2a49362) - Kojo, *Claude Opus 5*
- (**tickets**) open 50-53 for criteria the closed tickets left unchecked - (b8501f6) - Kojo, *Claude Opus 5*
- (**workflow**) simplify workflow activity controls - (42baf5f) - Kojo
- (**workflow**) define retained revision content - (39a5428) - Kojo
- (**workflow**) define discovery domain language - (29b32d3) - Kojo
- define host project registration context - (23c017a) - Kojo
- correct a refuted diagnosis, and name what CI actually found - (e68d49b) - Kojo, *Claude Opus 5*
- say how kojo is used, not only how it is built - (c908338) - Kojo, *Claude Opus 5*
- correct the ticket count — 54 is still open - (a882598) - Kojo, *Claude Opus 5*
- the tier was slow because the machine was busy, not because it was broken - (b8ecfbd) - Kojo, *Claude Opus 5*
- name the container engine correctly, and rule out the race by measuring - (66345f3) - Kojo, *Claude Opus 5*
- separate the Docker mount fault from the daemon, by measurement - (d7611c2) - Kojo, *Claude Opus 5*
- record wave 20 — what the four lanes bought, and what they cost - (e57962e) - Kojo, *Claude Opus 5*
#### Tests
- (**agent**) buy the pi resume criterion, two haiku calls, first time green - (1235978) - Kojo, *Claude Opus 5*
- (**agent**) take either credential in the real pi session gate, and say what else stops it - (3ac32d0) - Kojo, *Claude Opus 5*
- (**agent**) take either credential in the real pi session gate - (be7b93b) - Kojo, *Claude Opus 5*
- (**console**) draw the waterfall over two lanes at once - (56ef608) - Kojo, *Claude Opus 5*
- (**console**) draw the waterfall over two lanes held at once - (429607a) - Kojo, *Claude Opus 5*
- (**sandbox**) measure what the lane recovery costs, and close ticket 62 - (110ecfe) - Kojo, *Claude Opus 5*
- (**sandbox**) raise a timeout that was calibrated on one machine - (c79fce3) - Kojo, *Claude Opus 5*
- (**sandbox**) grade Kojo's answer to a stale dirty tree, not git's refusal - (a4d04b3) - Kojo, *Claude Opus 5*
- (**sandbox**) make the preserved-worktree test name its own precondition - (475a3b6) - Kojo, *Claude Opus 5*
- (**workflow**) buy the repaired envelope, on the third design - (2e3d05a) - Kojo, *Claude Opus 5*
#### Continuous Integration
- run the tests, and run them on main so the Test check exists - (e073bfc) - Kojo, *Claude Opus 5*
#### Miscellaneous Chores
- (**skills**) keep the agent skills in .agents and link .claude to them - (3c147ae) - Kojo, *Claude Opus 5*
- move issue tracking to GitHub - (e4cffda) - Kojo
- initial commit - (7f93cc1) - Kevin Abatan

- - -

Changelog generated by [cocogitto](https://github.com/cocogitto/cocogitto).