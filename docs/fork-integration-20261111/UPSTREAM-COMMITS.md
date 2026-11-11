# Upstream commits covered

All 156 commits reachable from `3493c0c6c06260e6c472bd230dc02d4b0308db43` but absent from fork baseline `3c01ce2c29a66fa9be573f573c9865b7cb20c030` are included by the integration merge.

| Commit | Subject |
| --- | --- |
| [`4652af6d`](https://github.com/stanley2058/lilac-mono/commit/4652af6dba4477e16a219109b97a05be858f6186) | fix(docker): cache CI image builds and install Bun by architecture |
| [`ba36e9ea`](https://github.com/stanley2058/lilac-mono/commit/ba36e9ea5262729c1631c67c66f4c8429cef3870) | feat(web): add a workflows view and a waiting thread status |
| [`cdf5c9a0`](https://github.com/stanley2058/lilac-mono/commit/cdf5c9a04f269aff9785d8abfffe889151825f87) | fix(test): remove the causes of flaky check and ci runs |
| [`5c8b39d2`](https://github.com/stanley2058/lilac-mono/commit/5c8b39d2078079883edcf6ce66aefa1c084a9abd) | fix(dev): reuse browser fixture database snapshots |
| [`e6b590bd`](https://github.com/stanley2058/lilac-mono/commit/e6b590bd2902a0101281ce19255e1e146023ff49) | fix(docker): add bunx to the runtime image |
| [`1bf249ba`](https://github.com/stanley2058/lilac-mono/commit/1bf249baeb8bd6f55a7c12a5cfd5c8befc1618f6) | feat(web): turn the workflows view into a status board |
| [`e2556102`](https://github.com/stanley2058/lilac-mono/commit/e255610243b47c178e68ef2899d12f98f56e4dd8) | fix(core): encode summary attachments before the model call |
| [`e28dec25`](https://github.com/stanley2058/lilac-mono/commit/e28dec25d8d4e1ff421542d91ad963a33c990341) | feat(utils): store the model catalog in shared SQLite |
| [`173f692a`](https://github.com/stanley2058/lilac-mono/commit/173f692ad3cc87428309d26d50884ebb35494aee) | fix(core): restart on main isolate memory instead of process RSS |
| [`f5a8ef36`](https://github.com/stanley2058/lilac-mono/commit/f5a8ef36db8d2506609dff0b4715bcfcb968868e) | perf(core): load heavy on-demand packages on first use |
| [`15c55ae2`](https://github.com/stanley2058/lilac-mono/commit/15c55ae281dc8c244b072350b38a554d083f2794) | test(core): probe strict stdin with the read builtin |
| [`399b90fb`](https://github.com/stanley2058/lilac-mono/commit/399b90fbf2402a7734807c3f0f541e3d0daa8564) | build: move the core image to Debian 13 and pin runners to Ubuntu 26.04 |
| [`f54c9816`](https://github.com/stanley2058/lilac-mono/commit/f54c981619a20491ffd9acfb2e0ceab1639e6587) | fix(web): keep message actions reachable from the message |
| [`6d590aa8`](https://github.com/stanley2058/lilac-mono/commit/6d590aa8e27e8028356e4028f526dd27c2501a4d) | feat(core): add background jobs that wake the agent when they end |
| [`601be988`](https://github.com/stanley2058/lilac-mono/commit/601be988ad82a8ecfadd8f48815aba0f81ef225c) | fix(core): show a running job's output as it arrives |
| [`7e9f1e84`](https://github.com/stanley2058/lilac-mono/commit/7e9f1e848cba8a96b647b51eae0998d3e8ca4441) | feat(core): log background jobs and choose their mode by when results are due |
| [`398248a5`](https://github.com/stanley2058/lilac-mono/commit/398248a588ec67ad2435693aaa35ed7d4f116388) | fix(web): open threads at the bottom and restore where the reader left |
| [`f7e54574`](https://github.com/stanley2058/lilac-mono/commit/f7e54574c60ae3dec1297606e1cf5d6b098e19f4) | feat(web): show queued and unsent messages in the timeline |
| [`f08cd041`](https://github.com/stanley2058/lilac-mono/commit/f08cd041640730e00869e9641ff5e5cafb42f730) | fix(web): give the first turn room below the thread header |
| [`ce9b6b92`](https://github.com/stanley2058/lilac-mono/commit/ce9b6b9259ace330717361aefdc8540e96885a4c) | fix(core): cap job output in the test at 64 KB instead of 50 MB |
| [`0e5c97c9`](https://github.com/stanley2058/lilac-mono/commit/0e5c97c9498c3ed9d18530e029ecb0193f7db816) | perf(core): scan bash output in runs instead of per character |
| [`7bf427e1`](https://github.com/stanley2058/lilac-mono/commit/7bf427e19e6076ea989702820be1e3785cbca74d) | fix(web): let thread shortcuts work while the composer has focus |
| [`48589538`](https://github.com/stanley2058/lilac-mono/commit/485895384e2c4c8ac9f1e08dd80bb459ccf36dae) | feat(core): recall conversation memory per subject and index the DM per window |
| [`e813bb4c`](https://github.com/stanley2058/lilac-mono/commit/e813bb4c5bf2c77d735dfe6427a4b24fc3b64f23) | fix(core): report a thread changed after its summary as stale |
| [`c229150c`](https://github.com/stanley2058/lilac-mono/commit/c229150c8f40ffc313d739541116ad1954189fee) | fix(core): rebuild Discord threads after index reset |
| [`f2c90667`](https://github.com/stanley2058/lilac-mono/commit/f2c90667ac5616796c992602ca5fb5be726cf40d) | feat(web): cap the turn rail at nine ticks that slide with the scroll |
| [`ec32e51f`](https://github.com/stanley2058/lilac-mono/commit/ec32e51f9771e8845d6a6c58b8107046c97ac51b) | fix(core): claim the session before recovery awaits and keep drain-time work |
| [`f40076c4`](https://github.com/stanley2058/lilac-mono/commit/f40076c427d31ac71770fc5bb5ed1145e8a1db9b) | fix(tooling): resolve infrastructure and small-app audit findings |
| [`4c392572`](https://github.com/stanley2058/lilac-mono/commit/4c392572b666859604e8bdd3828151c43e1843f3) | fix(core): make workflow recovery durable and maintain background jobs |
| [`69cc4f09`](https://github.com/stanley2058/lilac-mono/commit/69cc4f098b6fd0797ec068d3037393d6728d6669) | fix(tools): close audit gaps in safety, text editing, and compaction |
| [`c49e7bb7`](https://github.com/stanley2058/lilac-mono/commit/c49e7bb7f9d0d24a46dd4143525372f6b1709fb4) | refactor(core): separate workflow decoding and concurrency ownership |
| [`32bbc8aa`](https://github.com/stanley2058/lilac-mono/commit/32bbc8aa2796053f0f0847f2dd2383c99dc5c91b) | fix(core): bound agent runner drain and stop by the shutdown deadline |
| [`039802ce`](https://github.com/stanley2058/lilac-mono/commit/039802ce1d4e4a9754b19a8c2a31a80750c956d4) | fix(tooling): address lane review findings |
| [`79e11562`](https://github.com/stanley2058/lilac-mono/commit/79e1156246df9cd014411b766ccbc69280562bcf) | Merge lane I: tooling and infra audit fixes |
| [`98909838`](https://github.com/stanley2058/lilac-mono/commit/98909838147671d49bbb5ff7d6f4e461f2880752) | fix(core): skip a bad accepted record instead of failing startup |
| [`97c063c2`](https://github.com/stanley2058/lilac-mono/commit/97c063c2e96839f1edc3bff9dea1c0c5b2032e4c) | fix(core): evict idle agent runner session state |
| [`b5a3914c`](https://github.com/stanley2058/lilac-mono/commit/b5a3914cb0d6869ff87973198c37286d47b92350) | fix(core): settle agent controls per session off the bus handler |
| [`298f7779`](https://github.com/stanley2058/lilac-mono/commit/298f7779c57998e11370fbf2b190dd8f7d87d841) | fix(core): address security and tool server audit findings |
| [`807dfeb2`](https://github.com/stanley2058/lilac-mono/commit/807dfeb26e384c28d43d75ed1cf816344a813fc7) | perf(core): skip the checkpoint round trip and payload readback |
| [`372e71cb`](https://github.com/stanley2058/lilac-mono/commit/372e71cbf58a1caa2879aa08a3c2c16f8bbd378a) | fix(core): address workflow lane review findings |
| [`baf11e52`](https://github.com/stanley2058/lilac-mono/commit/baf11e52e41f5e2e1127dc3adab856ee72762b24) | Merge lane C: workflow, jobs and entity audit fixes |
| [`955ab4b7`](https://github.com/stanley2058/lilac-mono/commit/955ab4b7b4ddd59327050ab273718c8ab2244866) | perf(core): complete incremental discovery and shared SSH deployment |
| [`5c318281`](https://github.com/stanley2058/lilac-mono/commit/5c31828153741af122b1e821efc5937334c96283) | fix(core): point blob migration errors at the f2c90667 cutoff |
| [`d72d58e5`](https://github.com/stanley2058/lilac-mono/commit/d72d58e558ad352b340a581169813dae6b25270e) | fix(tools): address tool package review findings |
| [`9c38df98`](https://github.com/stanley2058/lilac-mono/commit/9c38df981be730184a5a93e093ed8358eced608f) | fix(core): hand control failures to the runner supervisor directly |
| [`69eee306`](https://github.com/stanley2058/lilac-mono/commit/69eee306777f676010696b46db68afeff12a3fad) | perf(core): append agent-run checkpoints as deltas |
| [`18e7e36a`](https://github.com/stanley2058/lilac-mono/commit/18e7e36a3949a03e38d8a3fd134046f2e9fe3b0a) | perf(core): cap published reasoning snapshots at the relay detail limit |
| [`db7d7655`](https://github.com/stanley2058/lilac-mono/commit/db7d76557e1ff023af05383b1699034fbe454b70) | perf(core): estimate each tool result's size once for pruning |
| [`b0d1c68e`](https://github.com/stanley2058/lilac-mono/commit/b0d1c68e1451e4af3efea46a48a5b7fff8084d7a) | perf(core): find the relay continuation overlap in linear time |
| [`9e285365`](https://github.com/stanley2058/lilac-mono/commit/9e28536579cd69dffa9234c48eeb8564bf2963d4) | refactor(core): drop no-op queue lifecycle abandon calls |
| [`b7cd99ad`](https://github.com/stanley2058/lilac-mono/commit/b7cd99adfd27794ed8d107343c2e6ac4ae739a2b) | refactor(core): share consumerId and the fresh-only lineage fallback |
| [`d519af48`](https://github.com/stanley2058/lilac-mono/commit/d519af48b23e9b93b572aa36a0fd4ed0fed4c62d) | fix(tools): address tool package re-check findings |
| [`2b21cb38`](https://github.com/stanley2058/lilac-mono/commit/2b21cb3869bfd40d5fced5c634b16e57b6cb5fa6) | Merge lane F: tool package and agent audit fixes |
| [`e8322602`](https://github.com/stanley2058/lilac-mono/commit/e83226025654fea25f4a8a25235fd51878c15c3b) | refactor(core): move provider and continuation modules into agent |
| [`33d4a6ef`](https://github.com/stanley2058/lilac-mono/commit/33d4a6efa76aac14855fee408328ce0f1e9a8b32) | fix(core): address security lane review findings |
| [`2e84fc79`](https://github.com/stanley2058/lilac-mono/commit/2e84fc795f7c26ff55de35a2a3d37afaf78bc47d) | Merge lane A: security and tool server audit fixes |
| [`3ca87f51`](https://github.com/stanley2058/lilac-mono/commit/3ca87f510221dfd09b7ea568dcc940b1d4eec519) | perf(tool-bridge): import the tool server host without the Core barrel |
| [`0037c587`](https://github.com/stanley2058/lilac-mono/commit/0037c58732f54a48b2a66a171dca3a8ce3478d84) | refactor(core): move runner helpers into bus-agent-runner modules |
| [`0ea9117c`](https://github.com/stanley2058/lilac-mono/commit/0ea9117ccfbc433d7717671d4c8897f1ad8d9e90) | refactor(core): extract the agent-run checkpoint writer from the runner |
| [`ed4e9601`](https://github.com/stanley2058/lilac-mono/commit/ed4e960198fc1a35a0ee08fcb723543f5eb7dd7d) | test(core): split the bus agent runner tests by runner module |
| [`eec29a0d`](https://github.com/stanley2058/lilac-mono/commit/eec29a0d6105c78ab728050f6e3ef6e2cdd64b47) | refactor(core): move runtime recovery, event bus, and router helpers out |
| [`d3234788`](https://github.com/stanley2058/lilac-mono/commit/d323478824cd5ae8ebca7bf8ad6962af8f9809d7) | refactor(core): extract a pure relay output reducer |
| [`651e23ad`](https://github.com/stanley2058/lilac-mono/commit/651e23adc1341d8a4598f38e76a034d7c94475b1) | fix(core): capture session drain and control rejections through Result |
| [`3fef99d9`](https://github.com/stanley2058/lilac-mono/commit/3fef99d9694177f9fc23eff30bdbf4b657289bd4) | fix(web): delete cleared drafts and cap saved drafts per principal |
| [`fbea7f5f`](https://github.com/stanley2058/lilac-mono/commit/fbea7f5ffba61f580936b4059bb39b3feb7889b0) | fix(web): keep settings links, the phone sidebar and optimistic sends correct |
| [`b4e6b37c`](https://github.com/stanley2058/lilac-mono/commit/b4e6b37c73fe66010c5fdd159b495509a91abbf2) | fix(core): fence unstarted runs and bound subscription stop during drain |
| [`7bad537f`](https://github.com/stanley2058/lilac-mono/commit/7bad537fcda0baecb7081889d8f3493287cf29dc) | perf(web): coalesce cache writes per thread and wait for typing pauses to save drafts |
| [`4aa655aa`](https://github.com/stanley2058/lilac-mono/commit/4aa655aa0b8f31004183969ea6bfc0f69367cd37) | perf(web): keep typing out of the conversation's render path |
| [`45e347b6`](https://github.com/stanley2058/lilac-mono/commit/45e347b62306a57f3eac481db183a91f6ca03e2e) | fix(event-bus): fence recovery races and reap abandoned subscriptions |
| [`085a4379`](https://github.com/stanley2058/lilac-mono/commit/085a437930c5e87b29966db1ff82386945e1b74e) | fix(claude-code): retain settlement failures and bound disposal |
| [`eaf0cc30`](https://github.com/stanley2058/lilac-mono/commit/eaf0cc30e1b73477e456232f6056c336895a69da) | perf(utils): bound response streams and bundle catalog as data |
| [`9426bda5`](https://github.com/stanley2058/lilac-mono/commit/9426bda59e88ea77f8ffc24bac240f0af62b260b) | fix(core): fail startup when the agent-run journal migration fails |
| [`2e3305ab`](https://github.com/stanley2058/lilac-mono/commit/2e3305abf11447fc91af2c8787e1f04d6a7c64c2) | fix(core): keep the relay truncation marker on capped reasoning |
| [`14df2307`](https://github.com/stanley2058/lilac-mono/commit/14df23071ccc6f59a43845b19af154e9454f2366) | perf(web): refresh only the newest turn-rail page when a turn changes |
| [`260fc336`](https://github.com/stanley2058/lilac-mono/commit/260fc3364f094987d174463aebd3648c0074de98) | perf(web): read the sidebar's reply drafts in one query |
| [`981c21a0`](https://github.com/stanley2058/lilac-mono/commit/981c21a0d9fee66260cb0eb2827f256975746364) | perf(web): skip presence reports that repeat the current view |
| [`253034df`](https://github.com/stanley2058/lilac-mono/commit/253034df09581c9746e9c2fc67a3a75acb133183) | fix(core): recheck a control's run before applying it to the agent |
| [`cf781d95`](https://github.com/stanley2058/lilac-mono/commit/cf781d958ef3e09fb2b6dd627a98a7344eb705b9) | perf(web): compile hot components with the React Compiler and check bails in CI |
| [`4f061237`](https://github.com/stanley2058/lilac-mono/commit/4f0612371553e98d622f3950d3d618d50be6663b) | fix(core): raise the journal migration failure through the host adapter |
| [`17631eea`](https://github.com/stanley2058/lilac-mono/commit/17631eea24397ed9c5cdd3fc6a6690dca03035c6) | fix(event-bus,utils): address lane review findings |
| [`2712cc64`](https://github.com/stanley2058/lilac-mono/commit/2712cc6422af3902ce8e12fc9545ca147ffaa50f) | Merge lane G: event bus, utils and Claude Code bridge audit fixes |
| [`82225e4a`](https://github.com/stanley2058/lilac-mono/commit/82225e4a8de21f5379f6657b612e0ba76c975149) | perf(web): replace Plate with a direct mdast codec for the composer |
| [`9b2fe17f`](https://github.com/stanley2058/lilac-mono/commit/9b2fe17f27e9d7cf74ab2be83f5977d134c6cf45) | fix(core): route an ended-run control through current session state |
| [`9a60b862`](https://github.com/stanley2058/lilac-mono/commit/9a60b8620c53c2d5ca5f58d5cd2e1491e04316ae) | Merge lane B: agent runner and runtime audit fixes |
| [`3ac9bd1a`](https://github.com/stanley2058/lilac-mono/commit/3ac9bd1a54c69ae0b4d603fb4d2ac636fad76b8a) | fix(core): release a superseded GitHub request's acknowledgement |
| [`98bc3a1e`](https://github.com/stanley2058/lilac-mono/commit/98bc3a1e5ebd1303793d870dd424d3f840854054) | feat(web): collapse empty workflow tracks and snap the board on phones |
| [`7d780876`](https://github.com/stanley2058/lilac-mono/commit/7d780876d46b594b75f80e52c6ee5517791b0eb4) | fix(web): fix sidebar list semantics and make the sidebar one tab stop |
| [`7a480cb2`](https://github.com/stanley2058/lilac-mono/commit/7a480cb2beeee3accad63fd069b9552e6a9db401) | fix(web): use conversation wording, hide the Clerk field under local sign-in, and style login errors |
| [`4f87c3c5`](https://github.com/stanley2058/lilac-mono/commit/4f87c3c545528a6344b2eab685f3a7aedc9c001d) | fix(core): keep the Discord preview until the final reply lands |
| [`6dc8f1ae`](https://github.com/stanley2058/lilac-mono/commit/6dc8f1ae11b9eeab849d15f2cc27720e62090b3e) | fix(web): polish task lists, image previews, file paths, scrollbars, toasts, and broken images |
| [`a6911094`](https://github.com/stanley2058/lilac-mono/commit/a6911094661e3ba7e640d09991fb5ff38594a591) | perf(web): drop full-viewport blur from dialog, file panel, and drop overlays |
| [`9eedd7f1`](https://github.com/stanley2058/lilac-mono/commit/9eedd7f1c25584620dd2ea347b440a4d63f954b0) | feat(web): debounce sidebar search, let Down enter the results, and highlight matches |
| [`02760aa4`](https://github.com/stanley2058/lilac-mono/commit/02760aa4354bae454e62e5890ad032fa4839c9ce) | fix(web): cap saved panel layouts at the 100 most recent conversations |
| [`1a3eccca`](https://github.com/stanley2058/lilac-mono/commit/1a3ecccaaf55520ddb5988753b61cabc2c7a0bf9) | refactor(web): keep the color scheme in the theme store |
| [`f2bb75a3`](https://github.com/stanley2058/lilac-mono/commit/f2bb75a3b7f5d6697b94aef816bab1917d408dcf) | refactor(web): keep conversation metadata in one store |
| [`a4c272e2`](https://github.com/stanley2058/lilac-mono/commit/a4c272e21e17d6192e8b9ce3e9fb7d152fc9a406) | fix(web): let the React Compiler compile the roving tab-stop hook |
| [`59d9d355`](https://github.com/stanley2058/lilac-mono/commit/59d9d3559ffc4efd6a73d499dcf4b349e45315d8) | refactor(web): split the design-system page and the timeline into modules |
| [`8a7014f1`](https://github.com/stanley2058/lilac-mono/commit/8a7014f1a76f2301ef1a8b218aedfa6ca96e3cee) | refactor(web): move the draft composer and search result row out of Chat and App |
| [`b3285a3b`](https://github.com/stanley2058/lilac-mono/commit/b3285a3b5e8270d86047424e65545576348b667a) | fix(core,client): address native replay, receipt, and materialization audit findings |
| [`010a6901`](https://github.com/stanley2058/lilac-mono/commit/010a6901b5909bffa0eeee69d42599ffc54709f1) | fix(web): open the phone sidebar without a tooltip on its toggle |
| [`cde793f6`](https://github.com/stanley2058/lilac-mono/commit/cde793f679663d453f2845d4030bfef4ffd08999) | fix(web): satisfy the architecture gate for the cache, rail, and presence changes |
| [`0140d689`](https://github.com/stanley2058/lilac-mono/commit/0140d6893b9df7239c1a09a560e96cc83209941e) | fix(core): continue Discord output in a fresh message when an edit target is gone |
| [`0fa7c230`](https://github.com/stanley2058/lilac-mono/commit/0fa7c230c3d40af0fe078028683564677ed70499) | fix(core): keep Discord error messages in classified surface errors |
| [`1bfcb324`](https://github.com/stanley2058/lilac-mono/commit/1bfcb324918345ae8a95a2fb7dab4c316e61d88c) | fix(core): reject Discord embed text past the description limit |
| [`b9a45e11`](https://github.com/stanley2058/lilac-mono/commit/b9a45e11f7bd4831a265bea821a07138cf63d492) | fix(core): drop a gated Discord batch after a mention supersedes it |
| [`f97d0ce8`](https://github.com/stanley2058/lilac-mono/commit/f97d0ce853eaa237c2f1d3ad30a97ae09ad46012) | perf(core): skip identical Discord embed edits and tick elapsed time every 5 s |
| [`bf8ccdfe`](https://github.com/stanley2058/lilac-mono/commit/bf8ccdfe054d600d3233318fd55a3abf497addb5) | fix(core,client): address native surface review findings |
| [`d1a774d3`](https://github.com/stanley2058/lilac-mono/commit/d1a774d356627ed9fdec4b6379176b7b17183280) | perf(core): send non-streaming Discord embeds without a streaming edit |
| [`9c245c92`](https://github.com/stanley2058/lilac-mono/commit/9c245c92562c6a27e4a16fa029265cc5cd887ceb) | fix(core): batch Discord uploads by the guild byte limit |
| [`e4a16334`](https://github.com/stanley2058/lilac-mono/commit/e4a163348e01383cb32f4f0e2a8d00b9a66c6b01) | perf(core): skip forced Discord message reads before edit and delete |
| [`b585f879`](https://github.com/stanley2058/lilac-mono/commit/b585f8790242053909201eba9fd3bff0a390a4f2) | perf(core): skip decoding the stored transcript on an unretained save |
| [`099ca249`](https://github.com/stanley2058/lilac-mono/commit/099ca249a52d070155fe1c6e2dfb108afb5e28ed) | perf(core): validate stored transcript messages once per codec read |
| [`dd2338b3`](https://github.com/stanley2058/lilac-mono/commit/dd2338b3404d52c4a87b223cee3c15a01b33bd9d) | perf(core): build transcript row schemas once |
| [`6d7b4f1f`](https://github.com/stanley2058/lilac-mono/commit/6d7b4f1f1ce16b738265611f2c52059bc1ab97c8) | perf(core): read only the final text for Discord reply gate context |
| [`60ade94f`](https://github.com/stanley2058/lilac-mono/commit/60ade94f1b5846eeaef43e6860bc9ff8a9411f08) | perf(core): index transcript retention and prune after the save commits |
| [`b32f707b`](https://github.com/stanley2058/lilac-mono/commit/b32f707bd50187513b4bf065ad335b77cfae486a) | perf(core): look up external thread runs by surface channel |
| [`03e3fdd4`](https://github.com/stanley2058/lilac-mono/commit/03e3fdd435ea59f164332af365a1c415ff0ef0ed) | docs: note that Discord messages sent while Core is offline go unanswered |
| [`6e014bff`](https://github.com/stanley2058/lilac-mono/commit/6e014bff046aa607a71c31007871549919d34772) | refactor(core): move transcript schema migrations into their own module |
| [`031d8d31`](https://github.com/stanley2058/lilac-mono/commit/031d8d31ee007682cb13a602b6423698205cf4a8) | fix(web): read cached slots that outgrew the wire part and message caps |
| [`84cfc352`](https://github.com/stanley2058/lilac-mono/commit/84cfc3520c5e7bb3ae04598da94ead9dd1b38740) | fix(web): commit pending drafts before the page hides or unloads |
| [`e4fc394c`](https://github.com/stanley2058/lilac-mono/commit/e4fc394cd1f5e8f1907ca226c2ad023499d20ab2) | fix(web): keep Tab inside the phone sidebar |
| [`ad81a2f0`](https://github.com/stanley2058/lilac-mono/commit/ad81a2f01b05943fd91800aeac2af99ee6279f27) | fix(web): list each React Compiler bail by function |
| [`3a0e9dce`](https://github.com/stanley2058/lilac-mono/commit/3a0e9dceeee6372b331b396c74f036c755f0730d) | fix(web): map the hide-time draft flush's capture for the architecture gate |
| [`b28cc7bd`](https://github.com/stanley2058/lilac-mono/commit/b28cc7bda277f54c4038f22e18c965782320dc33) | Merge lane H: web app audit fixes |
| [`910b2a20`](https://github.com/stanley2058/lilac-mono/commit/910b2a20541fd6508f97a95150c03c4da6191153) | fix(core): fall back to a window over undecodable legacy change rows |
| [`c4d9b6ce`](https://github.com/stanley2058/lilac-mono/commit/c4d9b6ceb7dd6b55323ae04b02fc93ebe7911f18) | Merge lane D: native surface and client audit fixes |
| [`6fafba8f`](https://github.com/stanley2058/lilac-mono/commit/6fafba8fbd6ec0b6e3c500b5a0590b2ba19cec41) | fix(core): compose the legacy change-row fallback with match |
| [`13b151bb`](https://github.com/stanley2058/lilac-mono/commit/13b151bb35fba715bd5d7968b575b19335299814) | fix(client,web): keep drafts on the scope key across projection bumps |
| [`2409814f`](https://github.com/stanley2058/lilac-mono/commit/2409814f073dc67de29589b5b8d121f262548486) | fix(core): split Discord upload batches by the per-request size limit |
| [`587676ac`](https://github.com/stanley2058/lilac-mono/commit/587676accb0e6825b7740dc5a156dc5d07046778) | fix(core): claim the Discord session before a debounced batch publishes |
| [`fa1d2e5e`](https://github.com/stanley2058/lilac-mono/commit/fa1d2e5e44d55c7ae77cc504c6e2be334f9df415) | test(core): cover single-pass transcript validation and hoisted row schemas |
| [`c9b78eac`](https://github.com/stanley2058/lilac-mono/commit/c9b78eac5238acdc21d2588d59484b6a7cf4c3b8) | Merge lane E: Discord surface and transcript audit fixes |
| [`06785109`](https://github.com/stanley2058/lilac-mono/commit/06785109b949e579462e0d1e981b77ad0a8bc86f) | chore: clear unused-variable lint warnings |
| [`f869c848`](https://github.com/stanley2058/lilac-mono/commit/f869c84823b4122c12c499ed3e95a44c0af05da5) | perf(core): react to Discord messages without a forced message read |
| [`5d79132a`](https://github.com/stanley2058/lilac-mono/commit/5d79132ac14cfc8ee2c11218fe5cd79f797ce00f) | fix(core): bound the agent runner's subscription stop by the shutdown deadline |
| [`41dbdaf2`](https://github.com/stanley2058/lilac-mono/commit/41dbdaf28aec01024decd676c6688a4c5ae0b253) | fix(bash-safety): allow scoped cleanup after cwd changes and find filters |
| [`19a50a3f`](https://github.com/stanley2058/lilac-mono/commit/19a50a3f868348c85fbf8ae9ed5cf525b4584d8e) | fix(core): run a steer its run never consumed as the session's next prompt |
| [`7c9110d6`](https://github.com/stanley2058/lilac-mono/commit/7c9110d6e2eb95eda0d45472c481aea3a1fe6ad3) | fix(web): recache threads that IndexedDB evicted |
| [`1047b0f4`](https://github.com/stanley2058/lilac-mono/commit/1047b0f439c41bb835da26067881859ab468c2ff) | test(core): size the seeded workflow agent cap to the seeded steps |
| [`cea719b6`](https://github.com/stanley2058/lilac-mono/commit/cea719b6f323c9ef0c9b4e9dcbf8c4692346e3e9) | perf(web): keep typing in a local conversation out of Chat's render path |
| [`93f8e38e`](https://github.com/stanley2058/lilac-mono/commit/93f8e38e7718d6a31331bda17ebdf53769f872b6) | perf(core): save one turn per native transcript row |
| [`0a616ae1`](https://github.com/stanley2058/lilac-mono/commit/0a616ae17b3eedacf810a2aded145dd4188e4129) | perf(core): read native turn content only for threads that changed |
| [`2b4cb7a1`](https://github.com/stanley2058/lilac-mono/commit/2b4cb7a104fab02bceedc3653d3bc3cc39284c2c) | fix(client): stop re-caching a thread its own replace evicts |
| [`31ee4c21`](https://github.com/stanley2058/lilac-mono/commit/31ee4c216ee860e780367f38e521ac8a4f5f1e4b) | Merge residuals R3: web cache recaching and local draft renders |
| [`136f08b3`](https://github.com/stanley2058/lilac-mono/commit/136f08b37100b6642a30f8e41de5aeb2e2f2f65b) | fix(core): report a subscription stop failure that lands after the shutdown deadline |
| [`8c87bec5`](https://github.com/stanley2058/lilac-mono/commit/8c87bec5b0d79a70381eb04bb865a59cf4c1251c) | fix(core): reread a Discord message before reporting its reaction absent |
| [`e85114b3`](https://github.com/stanley2058/lilac-mono/commit/e85114b380ab74b2c390582022cdd208f7613d55) | build(web): compile with Oxc's React Compiler instead of Babel |
| [`1cbe5c76`](https://github.com/stanley2058/lilac-mono/commit/1cbe5c767338a183f6120f56f84a1a0af81ee421) | Merge Oxc React Compiler switch for the web build |
| [`f79b4aa9`](https://github.com/stanley2058/lilac-mono/commit/f79b4aa9d79ac70bcc6776df228b3ac118002709) | fix(core): keep inherited compaction in native turn rows |
| [`7e1d80fd`](https://github.com/stanley2058/lilac-mono/commit/7e1d80fdf7c55d6a60bfd3eb3c001b0353d4a041) | Merge residuals R2: native turn transcripts and refresh fingerprints |
| [`65899e94`](https://github.com/stanley2058/lilac-mono/commit/65899e94effc24634f653ef8383b06aac46ba149) | fix(core): run a follow-up its run never consumed as the session's next prompt |
| [`d2435815`](https://github.com/stanley2058/lilac-mono/commit/d2435815ccc6aaa0945f9b8f5cca54fc309fac40) | fix(core): keep a cancelled run's unconsumed controls from running after it |
| [`c132d88c`](https://github.com/stanley2058/lilac-mono/commit/c132d88c19774ca93d9600915409fdfccc1fa4bb) | Merge residuals R1: unconsumed controls, stop deadline, Discord reactions |
| [`1ac81d91`](https://github.com/stanley2058/lilac-mono/commit/1ac81d91815e0482a0d3b6f148683a2b50c77b32) | Merge branch 'audit/integration' |
| [`89b76c8d`](https://github.com/stanley2058/lilac-mono/commit/89b76c8d8fbd3c2b52f666cfe2e7f9c387e312e0) | docs(plan): record the November audit decisions and residuals |
| [`3493c0c6`](https://github.com/stanley2058/lilac-mono/commit/3493c0c6c06260e6c472bd230dc02d4b0308db43) | fix(web): keep a single wheel notch from snapping the timeline back to the bottom |
