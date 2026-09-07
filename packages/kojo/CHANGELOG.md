# Changelog
All notable changes to this project will be documented in this file. See [conventional commits](https://www.conventionalcommits.org/) for commit guidelines.

- - -
## kojo@v0.1.0-alpha.3 - 2026-09-07
#### Tests
- reuse isolated workflow captures - (7bcddec) - Kevin Abatan
#### Refactoring
- (**ci**) simplify test and release workflows (#100) - (9e6104b) - Kevin Abatan

- - -

## kojo@v0.1.0-alpha.2 - 2026-09-06
#### Bug Fixes
- (**release**) publish directly through trusted publishing (#99) - (4ff20b0) - Kevin Abatan
#### Performance Improvements
- (**ci**) speed up alpha checks with isolated integration shards (#97) - (cab6748) - Kevin Abatan
#### Build system
- (**release**) publish only kojo and runtime to npm (#98) - (f5dd9cb) - Kevin Abatan
#### Miscellaneous Chores
- (**version**) v0.1.0-alpha.2 - (88c49d8) - kojo release

- - -

## kojo@v0.1.0-alpha.1 - 2026-09-06
#### Features
- (**agent**) refuse an agent call no one authorised, in the invoker - (bae2d21) - Kojo, *Claude Opus 5*
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
- (**sandbox**) never release a worktree git cannot answer about - (548e58e) - Kojo, *Claude Opus 5*
- (**tests**) let a fixture name its own trunk instead of inheriting one - (b7958cd) - Kojo, *Claude Opus 5*
- (**tests**) stop two fixtures passing on this machine's configuration - (10bec68) - Kojo, *Claude Opus 5*
- (**workflow**) bar the factory's own directory, in the guard rather than the list - (782ebfb) - Kojo, *Claude Opus 5*
- remove obsolete code and close alpha release gaps - (883f2e6) - Kevin Abatan
#### Documentation
- (**62**) the passing run refuted this ticket's own reading - (787a4dc) - Kojo, *Claude Opus 5*
#### Tests
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
- (**version**) v0.1.0-alpha.1 - (b477e94) - kojo release
- initial commit - (7f93cc1) - Kevin Abatan

- - -

## kojo@v0.1.0-alpha.2 - 2026-09-06
#### Bug Fixes
- (**release**) publish directly through trusted publishing (#99) - (4ff20b0) - Kevin Abatan
#### Performance Improvements
- (**ci**) speed up alpha checks with isolated integration shards (#97) - (cab6748) - Kevin Abatan
#### Build system
- (**release**) publish only kojo and runtime to npm (#98) - (f5dd9cb) - Kevin Abatan

- - -

## kojo@v0.1.0-alpha.1 - 2026-09-06
#### Features
- (**agent**) refuse an agent call no one authorised, in the invoker - (bae2d21) - Kojo, *Claude Opus 5*
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
- (**sandbox**) never release a worktree git cannot answer about - (548e58e) - Kojo, *Claude Opus 5*
- (**tests**) let a fixture name its own trunk instead of inheriting one - (b7958cd) - Kojo, *Claude Opus 5*
- (**tests**) stop two fixtures passing on this machine's configuration - (10bec68) - Kojo, *Claude Opus 5*
- (**workflow**) bar the factory's own directory, in the guard rather than the list - (782ebfb) - Kojo, *Claude Opus 5*
- remove obsolete code and close alpha release gaps - (883f2e6) - Kevin Abatan
#### Documentation
- (**62**) the passing run refuted this ticket's own reading - (787a4dc) - Kojo, *Claude Opus 5*
#### Tests
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
- (**version**) v0.1.0-alpha.1 - (b477e94) - kojo release
- initial commit - (7f93cc1) - Kevin Abatan

- - -

## kojo@v0.1.0-alpha.1 - 2026-09-06
#### Features
- (**agent**) refuse an agent call no one authorised, in the invoker - (bae2d21) - Kojo, *Claude Opus 5*
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
- (**sandbox**) never release a worktree git cannot answer about - (548e58e) - Kojo, *Claude Opus 5*
- (**tests**) let a fixture name its own trunk instead of inheriting one - (b7958cd) - Kojo, *Claude Opus 5*
- (**tests**) stop two fixtures passing on this machine's configuration - (10bec68) - Kojo, *Claude Opus 5*
- (**workflow**) bar the factory's own directory, in the guard rather than the list - (782ebfb) - Kojo, *Claude Opus 5*
- remove obsolete code and close alpha release gaps - (883f2e6) - Kevin Abatan
#### Documentation
- (**62**) the passing run refuted this ticket's own reading - (787a4dc) - Kojo, *Claude Opus 5*
#### Tests
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
- initial commit - (7f93cc1) - Kevin Abatan

- - -

Changelog generated by [cocogitto](https://github.com/cocogitto/cocogitto).