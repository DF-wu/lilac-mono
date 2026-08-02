import type { ArchitectureBaseline } from "./model.ts";

export const boundaryValidationBaseline = {
  "apps/acp-controller": {
    "architecture/no-domain-unknown": [
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-domain-unknown|identity=acp-harness-client.ts%23errorMessage%5BParameter%5D%401|sha256=077af64d0e77088263523c1a73385c01edba48f1fb1ed258f6f95c5a1508e135",
        identity: "acp-harness-client.ts#errorMessage[Parameter]@1",
        location: {
          file: "acp-harness-client.ts",
          line: 22,
          column: 23,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-domain-unknown|identity=acp-harness-client.ts%23isAuthRequiredError%5BParameter%5D%401|sha256=f03ef4b9e8d30598686180386f3c99a6a43e6e8837f1392645d418e3cb7bb706",
        identity: "acp-harness-client.ts#isAuthRequiredError[Parameter]@1",
        location: {
          file: "acp-harness-client.ts",
          line: 235,
          column: 37,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-domain-unknown|identity=cli-flags.ts%23toInt%5BParameter%5D%401|sha256=f9705f582c2fb976ed87dadafd12c5cbe7268fad3ca5558205b4c0d519a17bc6",
        identity: "cli-flags.ts#toInt[Parameter]@1",
        location: {
          file: "cli-flags.ts",
          line: 1,
          column: 16,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-domain-unknown|identity=cli-flags.ts%23toBool%5BParameter%5D%401|sha256=3a9ade4c141c865ba2f4459cc61742d608e1f2cf9a1b8df2e26b0a7571c6f3da",
        identity: "cli-flags.ts#toBool[Parameter]@1",
        location: {
          file: "cli-flags.ts",
          line: 10,
          column: 17,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-domain-unknown|identity=controller.ts%23%3Cmodule%3E%5BParameter%5D%401|sha256=85faeb6f32b8108828c9056f6db29703fdc6140ff731fc33a25de2774e9c23bf",
        identity: "controller.ts#<module>[Parameter]@1",
        location: {
          file: "controller.ts",
          line: 34,
          column: 22,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-domain-unknown|identity=controller.ts%23printJson%5BParameter%5D%401|sha256=c1c437aaee740194f15bc4300052ec82bf8558740a36ad60a4948740f4965465",
        identity: "controller.ts#printJson[Parameter]@1",
        location: {
          file: "controller.ts",
          line: 47,
          column: 20,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-domain-unknown|identity=controller.ts%23isRecord%5BParameter%5D%401|sha256=72127beb8bd66e4f98ad674dad09240c4558f34c62a7594f73db1e2ba0fd726c",
        identity: "controller.ts#isRecord[Parameter]@1",
        location: {
          file: "controller.ts",
          line: 55,
          column: 19,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-domain-unknown|identity=controller.ts%23getString%5BParameter%5D%401|sha256=a05daacdd21019e29e943be0db4b2a7896b1defd844b8b38039fc8baa288342e",
        identity: "controller.ts#getString[Parameter]@1",
        location: {
          file: "controller.ts",
          line: 59,
          column: 20,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-domain-unknown|identity=controller.ts%23getNumber%5BParameter%5D%401|sha256=5aa6ae9bc14216813df56aa324f1eaadb09492135c993ce673da2b48b143834b",
        identity: "controller.ts#getNumber[Parameter]@1",
        location: {
          file: "controller.ts",
          line: 63,
          column: 20,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-domain-unknown|identity=controller.ts%23getBoolean%5BParameter%5D%401|sha256=1cff034d391109262e49f808c69ba6730df3b31e3be0d9dbb59d18b119811d9e",
        identity: "controller.ts#getBoolean[Parameter]@1",
        location: {
          file: "controller.ts",
          line: 67,
          column: 21,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-domain-unknown|identity=controller.ts%23getRecordArray%5BParameter%5D%401|sha256=f6739dc04191a3b45b6b40ca83452acc02c486dace8fd31d010cdc200d4f0b56",
        identity: "controller.ts#getRecordArray[Parameter]@1",
        location: {
          file: "controller.ts",
          line: 71,
          column: 25,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-domain-unknown|identity=controller.ts%23getStringArray%5BParameter%5D%401|sha256=fd06443aef444350edc9a160a61ade58bef3dd062869ed01faf032fe796fc341",
        identity: "controller.ts#getStringArray[Parameter]@1",
        location: {
          file: "controller.ts",
          line: 75,
          column: 25,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-domain-unknown|identity=controller.ts%23toListedSession%5BParameter%5D%401|sha256=b0ef771e093009d4f8bbf210b96d4fe452812b98136f5136425588ff7809981c",
        identity: "controller.ts#toListedSession[Parameter]@1",
        location: {
          file: "controller.ts",
          line: 86,
          column: 26,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-domain-unknown|identity=controller.ts%23formatCandidates%5BParameter%5D%401|sha256=8de9368585534991b24b5239fec94c21ac8f0dd4c1c3d5cd5dc28b6591824277",
        identity: "controller.ts#formatCandidates[Parameter]@1",
        location: {
          file: "controller.ts",
          line: 126,
          column: 27,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-domain-unknown|identity=controller.ts%23formatSnapshotPlan%5BParameter%5D%401|sha256=12c2c3db2471c42bd300e81cf589cfadb72d31fe8ceeab0d9802db9a064aa07b",
        identity: "controller.ts#formatSnapshotPlan[Parameter]@1",
        location: {
          file: "controller.ts",
          line: 177,
          column: 29,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-domain-unknown|identity=controller.ts%23formatRecentRuns%5BParameter%5D%401|sha256=bbb23aa3cfeb636be1312f1a66d260c0b20eeae7e79a8b745f5b1f3c2122be74",
        identity: "controller.ts#formatRecentRuns[Parameter]@1",
        location: {
          file: "controller.ts",
          line: 192,
          column: 27,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-domain-unknown|identity=controller.ts%23formatHumanOutput%5BParameter%5D%401|sha256=d6e0723692ec33250e996dd332cd47e26252d7f735373050c8d222528dcb766c",
        identity: "controller.ts#formatHumanOutput[Parameter]@1",
        location: {
          file: "controller.ts",
          line: 287,
          column: 28,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-domain-unknown|identity=controller.ts%23createOutputWriter.%3Ccallback%3E%5BParameter%5D%401|sha256=2a50c57b9ce5df9535bdf3d8539bea909cc205f9810d82da9b23928dd965a925",
        identity: "controller.ts#createOutputWriter.<callback>[Parameter]@1",
        location: {
          file: "controller.ts",
          line: 316,
          column: 11,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-domain-unknown|identity=controller.ts%23errorMessage%5BParameter%5D%401|sha256=8d0b173e7a2be2a36ca83fe6ba0a7bdfb77696b7ccf6411a81d611489e558983",
        identity: "controller.ts#errorMessage[Parameter]@1",
        location: {
          file: "controller.ts",
          line: 339,
          column: 23,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-domain-unknown|identity=controller.ts%23collectSessionsForHarness.%3Ccallback%3E%5BParameter%5D%401|sha256=66a77de8798f77106f9f30927ed1ffc30c8a48b8ecfe27c29d704617e76af3cc",
        identity: "controller.ts#collectSessionsForHarness.<callback>[Parameter]@1",
        location: {
          file: "controller.ts",
          line: 487,
          column: 71,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-domain-unknown|identity=controller.ts%23collectSessions.%3Ccallback%3E%5BParameter%5D%401|sha256=12ccb968a58486bcc51004c75d6a52fb2a43cdc756960787abdb6a7c14edfc06",
        identity: "controller.ts#collectSessions.<callback>[Parameter]@1",
        location: {
          file: "controller.ts",
          line: 543,
          column: 15,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-domain-unknown|identity=controller.ts%23runWorkerProcess.%3Ccallback%3E%5BParameter%5D%401|sha256=4af6810826b1797b4351171d251c89da2e92be686d88850c6f82afd8e9f25875",
        identity: "controller.ts#runWorkerProcess.<callback>[Parameter]@1",
        location: {
          file: "controller.ts",
          line: 1136,
          column: 19,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
    ],
    "architecture/no-unknown-assertion": [
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-unknown-assertion|identity=acp-harness-client.ts%23AcpHarnessClient.connect%5BAsExpression%5D%401|sha256=16d4ad17f9677bb9dcd9c16647f8dd85384298a5afbb846d772ef821a6068e50",
        identity: "acp-harness-client.ts#AcpHarnessClient.connect[AsExpression]@1",
        location: {
          file: "acp-harness-client.ts",
          line: 107,
          column: 20,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-unknown-assertion|identity=run-store.ts%23withSessionIndexLock%5BAsExpression%5D%401|sha256=fd742a383a94c2165ace6b730fdbc2b8b91c5d4a71fe0177c36b0f479a9397fa",
        identity: "run-store.ts#withSessionIndexLock[AsExpression]@1",
        location: {
          file: "run-store.ts",
          line: 75,
          column: 19,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-unknown-assertion|identity=run-store.ts%23loadSessionIndex%5BAsExpression%5D%401|sha256=6d4e6cb83ecbc16977c50851261d884437e2b98a1d3e161272a453dc7cd825f4",
        identity: "run-store.ts#loadSessionIndex[AsExpression]@1",
        location: {
          file: "run-store.ts",
          line: 121,
          column: 10,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
    ],
    "architecture/no-unregistered-decoder": [
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-unregistered-decoder|identity=run-store.ts%23loadRunRecord%5BCallExpression%5D%401|sha256=7da2c2de859a126af4c0b854c25530f3ceb4ff8f6e177346bc7be2cb47fdd74c",
        identity: "run-store.ts#loadRunRecord[CallExpression]@1",
        location: {
          file: "run-store.ts",
          line: 99,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-unregistered-decoder|identity=run-store.ts%23loadSessionIndex%5BCallExpression%5D%401|sha256=6f5382f142cdf8d1327e9d52ab9a4342024af86fc446c3ede0bcd1b71b7ec039",
        identity: "run-store.ts#loadSessionIndex[CallExpression]@1",
        location: {
          file: "run-store.ts",
          line: 115,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
    ],
    "architecture/no-rich-unknown-predicate": [
      {
        fingerprint:
          "arch-v2|workspace=apps%2Facp-controller|rule=architecture%2Fno-rich-unknown-predicate|identity=controller.ts%23isRecord%5BFunctionDeclaration%5D%401|sha256=b9005d26d630900b9a77face652bf329e19f86e322fb304345016ea364bc8257",
        identity: "controller.ts#isRecord[FunctionDeclaration]@1",
        location: {
          file: "controller.ts",
          line: 55,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
    ],
  },
  "apps/core": {
    "architecture/no-unknown-assertion": [
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fsurface%2Fadapter.ts%23hasAuthoritativeSelfMessageProvider%5BAsExpression%5D%401|sha256=1ad0c4806920adbc26e66f8f75284458f93c839c67a6d919056d05de919d44fb",
        identity: "src/surface/adapter.ts#hasAuthoritativeSelfMessageProvider[AsExpression]@1",
        location: {
          file: "src/surface/adapter.ts",
          line: 146,
          column: 17,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fsurface%2Fadapter.ts%23hasReplyChainPlannerProvider%5BAsExpression%5D%401|sha256=fead9f5d4c96018a06e97fbe05cac838701952815196371e5c6e26643980b0bc",
        identity: "src/surface/adapter.ts#hasReplyChainPlannerProvider[AsExpression]@1",
        location: {
          file: "src/surface/adapter.ts",
          line: 168,
          column: 17,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fsurface%2Fadapter.ts%23hasCacheBurstProvider%5BAsExpression%5D%401|sha256=77bba5483eed29ddac71e48e0d65fdf72b1eb6734beeb9b2bec775b53584847f",
        identity: "src/surface/adapter.ts#hasCacheBurstProvider[AsExpression]@1",
        location: {
          file: "src/surface/adapter.ts",
          line: 195,
          column: 17,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fsurface%2Fstore%2Fdiscord-surface-store.ts%23DiscordSurfaceStore.getSession%5BAsExpression%5D%401|sha256=abd33fb3f75b06e9c156d050dcb3c5bd6dcf8ef9758159ac6e94b70a008cfe38",
        identity:
          "src/surface/store/discord-surface-store.ts#DiscordSurfaceStore.getSession[AsExpression]@1",
        location: {
          file: "src/surface/store/discord-surface-store.ts",
          line: 204,
          column: 12,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fsurface%2Fstore%2Fdiscord-surface-store.ts%23DiscordSurfaceStore.getUserIdByUsername%5BAsExpression%5D%401|sha256=88a568c5123ddede3488a07394fc25684e734ffb194f1c5aad73162fa086a811",
        identity:
          "src/surface/store/discord-surface-store.ts#DiscordSurfaceStore.getUserIdByUsername[AsExpression]@1",
        location: {
          file: "src/surface/store/discord-surface-store.ts",
          line: 259,
          column: 17,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fsurface%2Fstore%2Fdiscord-surface-store.ts%23DiscordSurfaceStore.getUserName%5BAsExpression%5D%401|sha256=25a5dcd58085a35477eb9c425174ac741cc8665c066efb01231b56f12afe1e9c",
        identity:
          "src/surface/store/discord-surface-store.ts#DiscordSurfaceStore.getUserName[AsExpression]@1",
        location: {
          file: "src/surface/store/discord-surface-store.ts",
          line: 266,
          column: 12,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fsurface%2Fstore%2Fdiscord-surface-store.ts%23DiscordSurfaceStore.getChannelName%5BAsExpression%5D%401|sha256=ff3bc91cd73797f85668bcea99bb4aa069ae10eb5b002c8f8c5325c4a40ac97a",
        identity:
          "src/surface/store/discord-surface-store.ts#DiscordSurfaceStore.getChannelName[AsExpression]@1",
        location: {
          file: "src/surface/store/discord-surface-store.ts",
          line: 285,
          column: 12,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fsurface%2Fstore%2Fdiscord-surface-store.ts%23DiscordSurfaceStore.getRoleName%5BAsExpression%5D%401|sha256=fe2b61e5ead26a1af96129ccb23ae55b2cb840b9bbea5f1b0a66105df00a5dc2",
        identity:
          "src/surface/store/discord-surface-store.ts#DiscordSurfaceStore.getRoleName[AsExpression]@1",
        location: {
          file: "src/surface/store/discord-surface-store.ts",
          line: 304,
          column: 12,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fsurface%2Fstore%2Fdiscord-surface-store.ts%23DiscordSurfaceStore.getMessageRelation%5BAsExpression%5D%401|sha256=7211a476b39380eca8d2a8f1f6fcf9c5e5ba03f7e6027a5bcb4880d3f1768df3",
        identity:
          "src/surface/store/discord-surface-store.ts#DiscordSurfaceStore.getMessageRelation[AsExpression]@1",
        location: {
          file: "src/surface/store/discord-surface-store.ts",
          line: 365,
          column: 12,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fsurface%2Fstore%2Fdiscord-surface-store.ts%23DiscordSurfaceStore.getOrInitReadState%5BAsExpression%5D%401|sha256=0bbb7a3e4d41b5861250328e57435f7683db847368368ba4d2c778f89a707ef2",
        identity:
          "src/surface/store/discord-surface-store.ts#DiscordSurfaceStore.getOrInitReadState[AsExpression]@1",
        location: {
          file: "src/surface/store/discord-surface-store.ts",
          line: 416,
          column: 22,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fsurface%2Fdiscord%2Foutput%2Fdiscord-output-stream.ts%23fetchExistingMessagesForResume%5BAsExpression%5D%401|sha256=b2008d5ca132e14441e68f3bc03cb04dbe1c7d089a093dbf3b75cda60044dbeb",
        identity:
          "src/surface/discord/output/discord-output-stream.ts#fetchExistingMessagesForResume[AsExpression]@1",
        location: {
          file: "src/surface/discord/output/discord-output-stream.ts",
          line: 451,
          column: 5,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fsurface%2Fdiscord%2Fdiscord-message-meta.ts%23getDiscordMessageTypeName%5BAsExpression%5D%401|sha256=e1058fe28249e08e6ff98b066381794135e79e0034882687bb4023b8e05c0a61",
        identity:
          "src/surface/discord/discord-message-meta.ts#getDiscordMessageTypeName[AsExpression]@1",
        location: {
          file: "src/surface/discord/discord-message-meta.ts",
          line: 309,
          column: 17,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fsurface%2Fdiscord%2Fdiscord-adapter.ts%23DiscordAdapter.onMessageCreate%5BAsExpression%5D%401|sha256=269737c4bd88a689890d7c72ca7ac0e96d4226ab3148ec961f450d4193189766",
        identity:
          "src/surface/discord/discord-adapter.ts#DiscordAdapter.onMessageCreate[AsExpression]@1",
        location: {
          file: "src/surface/discord/discord-adapter.ts",
          line: 2559,
          column: 24,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.saveRequestTranscript.%3Ccallback%3E%5BAsExpression%5D%401|sha256=ab9ebba60b6b50c06ebef26773e67d248b097d39b338c1111fbd2b5742ed50d5",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.saveRequestTranscript.<callback>[AsExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1347,
          column: 24,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getCoreSurfaceProjection%5BAsExpression%5D%401|sha256=2b1f515a63b3fc417b5c9b6a8fad71985fe8adb408dc131def3ba41e6d364fe1",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getCoreSurfaceProjection[AsExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1541,
          column: 17,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getLatestCoreSurfaceSegment%5BAsExpression%5D%401|sha256=50b189ff5fd73fec67a30ca92ac781a675591a16c2627bf338327d242ea63ec9",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getLatestCoreSurfaceSegment[AsExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1613,
          column: 17,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getCorePrimaryLineageManifest%5BAsExpression%5D%401|sha256=e3897c5ce804438da0d9d250d15f989370c15fd8afd0f12d5477583e2e46113b",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getCorePrimaryLineageManifest[AsExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1663,
          column: 17,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.saveCorePrimaryLineageManifestInTransaction%5BAsExpression%5D%401|sha256=2c9a3c7cc2fac79ad964dde55162dc0e149ab64bfaa94849696006d75b863ba7",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.saveCorePrimaryLineageManifestInTransaction[AsExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1691,
          column: 22,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.validateCorePrimaryLineageReferences%5BAsExpression%5D%401|sha256=cc17f2c240d8927ce9be103dcbcdd8174a9b5964af4c79a6137f3de440422ff8",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.validateCorePrimaryLineageReferences[AsExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1848,
          column: 29,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getCoreOwnedBlobOrNull%5BAsExpression%5D%401|sha256=db88e5acb176589752b501405d4da4939b049b636d918a6ae89b02d708bf7810",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getCoreOwnedBlobOrNull[AsExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1910,
          column: 17,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.unlinkSurfaceMessage.%3Ccallback%3E%5BAsExpression%5D%401|sha256=4c6eb64beeab8f8c886fb7cbe60f8750923e57045091ca7d0a31a785230174c8",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.unlinkSurfaceMessage.<callback>[AsExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1922,
          column: 23,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.unlinkSurfaceMessage.%3Ccallback%3E%5BAsExpression%5D%401|sha256=93b36a7eb2734c563131dc62d7e8ce9f3143b5622d9f971cfeeecdd6ae2e41d9",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.unlinkSurfaceMessage.<callback>[AsExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1939,
          column: 26,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.deleteUnlinkedCheckpointCandidate.%3Ccallback%3E%5BAsExpression%5D%401|sha256=2f942675c0a20856e4e4279568c25355b2b2f5f67f45deedf0a36f196e8da9a4",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.deleteUnlinkedCheckpointCandidate.<callback>[AsExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1963,
          column: 26,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getTranscriptBySurfaceMessage%5BAsExpression%5D%401|sha256=06eb949b854df82e3cdefb290b7a9f37b116ca00d131f9d7c96b77c53d689363",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getTranscriptBySurfaceMessage[AsExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2013,
          column: 20,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getTranscriptBySurfaceMessage%5BAsExpression%5D%401|sha256=1eb2d9c5ed1a74ef60e4c7542d4252ac8f4dd94d9e8c9add88dd3402a5335971",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getTranscriptBySurfaceMessage[AsExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2023,
          column: 17,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getLatestTranscriptBySession%5BAsExpression%5D%401|sha256=7b65b91a7490f3219304c6b2c4ac7fabd5fd396f731f0f746e3691e1dc124551",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getLatestTranscriptBySession[AsExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2039,
          column: 17,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getRequestTranscript%5BAsExpression%5D%401|sha256=dd3d92bfa6629b405c943b0fef737927508858a409888521cab49a60f28a35e6",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getRequestTranscript[AsExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2057,
          column: 17,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getLatestCompleteNamedTranscript%5BAsExpression%5D%401|sha256=3bb7fdf58f81b275c538bdb1507c91169aa51ad3b89c1fc56834b3eac2730a2b",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getLatestCompleteNamedTranscript[AsExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2073,
          column: 20,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getCoreNamedClaudeSessionBinding%5BAsExpression%5D%401|sha256=519fd675880b331b6aee050c6c025aa66bf41ccd158b4cf851dd95a80563ddbb",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getCoreNamedClaudeSessionBinding[AsExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2092,
          column: 17,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getCoreNamedClaudeSessionAttempt%5BAsExpression%5D%401|sha256=53e6300c4bd4f9c551535bfa1b7832d20ed07c77c706249da2654ded8c8fdd3f",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getCoreNamedClaudeSessionAttempt[AsExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2115,
          column: 17,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getCorePrimaryClaudeSessionBinding.read%5BAsExpression%5D%401|sha256=ce5eafbe16d34a33d9826e2ebb1e942f263f4166b70eb648ee8fe0fb06ad8899",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getCorePrimaryClaudeSessionBinding.read[AsExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2365,
          column: 7,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getCorePrimaryClaudeSessionAttempt%5BAsExpression%5D%401|sha256=c582ee44935fad258c021a764b01f387ad3cd6eff69bd5f056e0220769b26e51",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getCorePrimaryClaudeSessionAttempt[AsExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2511,
          column: 17,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.canRecoverCoreNamedPromotion%5BAsExpression%5D%401|sha256=749d44fee32c27cd679e43806dfcfb08ff33f7c880fa5ebe5434eed1432fa547",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.canRecoverCoreNamedPromotion[AsExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3076,
          column: 21,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.canRecoverCorePrimaryPromotion%5BAsExpression%5D%401|sha256=a8c54c30dd461674788f5d5a101aa644784b8872b30424146cecbc235dd86029",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.canRecoverCorePrimaryPromotion[AsExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3492,
          column: 21,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.pruneRetention%5BAsExpression%5D%401|sha256=3dda3a58e45d785548c3c4dd80265a743efadedd68c368b0be972fddb7f3a0ca",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.pruneRetention[AsExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3746,
          column: 22,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fsurface%2Fstore%2Fdiscord-search-store.ts%23DiscordSearchStore.migrate%5BAsExpression%5D%401|sha256=4fcd851888f686514ba74540be582f5b25159fbdc6745994533022e1d624cd68",
        identity:
          "src/surface/store/discord-search-store.ts#DiscordSearchStore.migrate[AsExpression]@1",
        location: {
          file: "src/surface/store/discord-search-store.ts",
          line: 207,
          column: 25,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fsurface%2Fstore%2Fdiscord-search-store.ts%23DiscordSearchStore.migrate%5BAsExpression%5D%401|sha256=7211170840f06c2edea05c2ee181c9f54b5b3a769a80322deb65f19b1312fe92",
        identity:
          "src/surface/store/discord-search-store.ts#DiscordSearchStore.migrate[AsExpression]@1",
        location: {
          file: "src/surface/store/discord-search-store.ts",
          line: 210,
          column: 25,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fsurface%2Fstore%2Fdiscord-search-store.ts%23DiscordSearchStore.countMessagesByChannel%5BAsExpression%5D%401|sha256=452804555783698ee715fcd644762173cbb9c98b626a6012e56f78dd97c8b96b",
        identity:
          "src/surface/store/discord-search-store.ts#DiscordSearchStore.countMessagesByChannel[AsExpression]@1",
        location: {
          file: "src/surface/store/discord-search-store.ts",
          line: 299,
          column: 17,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fsurface%2Fstore%2Fdiscord-search-store.ts%23DiscordSearchStore.getIndexedMessage%5BAsExpression%5D%401|sha256=4db8bb5063da1226aa55cadcefc18a6cce09312b5091169100fff370d4d2a663",
        identity:
          "src/surface/store/discord-search-store.ts#DiscordSearchStore.getIndexedMessage[AsExpression]@1",
        location: {
          file: "src/surface/store/discord-search-store.ts",
          line: 309,
          column: 17,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fdiscovery%2Fdiscovery-service.ts%23SqliteDiscoveryStore.migrate%5BAsExpression%5D%401|sha256=168b161cd6df41106cfc579f9ea5e2a1093300d176ed69890382e17409cfb825",
        identity: "src/discovery/discovery-service.ts#SqliteDiscoveryStore.migrate[AsExpression]@1",
        location: {
          file: "src/discovery/discovery-service.ts",
          line: 740,
          column: 38,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fconversation%2Fthread-store.ts%23ConversationThreadStore.getThread%5BAsExpression%5D%401|sha256=6c1513fd64d7d4b1cf657a363946cd92713751e555d83d66b89290ece31fa932",
        identity:
          "src/conversation/thread-store.ts#ConversationThreadStore.getThread[AsExpression]@1",
        location: {
          file: "src/conversation/thread-store.ts",
          line: 1243,
          column: 12,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fconversation%2Fthread-store.ts%23ConversationThreadStore.getSummary%5BAsExpression%5D%401|sha256=3831d741d415abdba72fb001c0fa4ca0124e7421146597bb86aab35c25a5495f",
        identity:
          "src/conversation/thread-store.ts#ConversationThreadStore.getSummary[AsExpression]@1",
        location: {
          file: "src/conversation/thread-store.ts",
          line: 1249,
          column: 17,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fconversation%2Fthread-store.ts%23ConversationThreadStore.countThreadMessages%5BAsExpression%5D%401|sha256=b5db33fcf56137dcc5441a2db76ccdfad12668ff6f3aeaed5ce7d9c3a774dd42",
        identity:
          "src/conversation/thread-store.ts#ConversationThreadStore.countThreadMessages[AsExpression]@1",
        location: {
          file: "src/conversation/thread-store.ts",
          line: 1310,
          column: 17,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fconversation%2Fthread-store.ts%23ConversationThreadStore.upsertSummary.%3Ccallback%3E%5BAsExpression%5D%401|sha256=907de65706b043377bc9a30bba8ac60bbf883703c2ab815594027631a2972c45",
        identity:
          "src/conversation/thread-store.ts#ConversationThreadStore.upsertSummary.<callback>[AsExpression]@1",
        location: {
          file: "src/conversation/thread-store.ts",
          line: 1666,
          column: 25,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftools%2Frestricted-bash.ts%23buildNestedToolInput%5BAsExpression%5D%401|sha256=a669e4b1a6375fab40a37133dd90767d1fefb4afc31a95e5b527c1179818736c",
        identity: "src/tools/restricted-bash.ts#buildNestedToolInput[AsExpression]@1",
        location: {
          file: "src/tools/restricted-bash.ts",
          line: 350,
          column: 15,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftools%2Ffs%2Ffs.ts%23boundSearchOutput%5BAsExpression%5D%401|sha256=eb797958fc79167c906ad2619033fe1bef0a2df9fc9d933c0341d67b1bdf7461",
        identity: "src/tools/fs/fs.ts#boundSearchOutput[AsExpression]@1",
        location: {
          file: "src/tools/fs/fs.ts",
          line: 410,
          column: 18,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftools%2Ffs%2Ffs.ts%23boundSearchOutput%5BAsExpression%5D%401|sha256=5b6dd63c383f00c82afd2bc45e4c0d30e596b23250b52a826e105ca03c0c0c14",
        identity: "src/tools/fs/fs.ts#boundSearchOutput[AsExpression]@1",
        location: {
          file: "src/tools/fs/fs.ts",
          line: 415,
          column: 25,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftools%2Ffs%2Ffs.ts%23fsTool.isAttachmentOutput%5BAsExpression%5D%401|sha256=18bd922841682bf350a892c70f800d14801257661e81e203b9bef18a9ac965b3",
        identity: "src/tools/fs/fs.ts#fsTool.isAttachmentOutput[AsExpression]@1",
        location: {
          file: "src/tools/fs/fs.ts",
          line: 842,
          column: 15,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftools%2Ftool-args-display.ts%23safeValidateSync%5BAsExpression%5D%401|sha256=d4b5ab52e21813d4004cc9acf5cb569777164e991a645ade7e6a7f960fff3e8d",
        identity: "src/tools/tool-args-display.ts#safeValidateSync[AsExpression]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 40,
          column: 23,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftools%2Ftool-args-display.ts%23safeValidateSync%5BAsExpression%5D%401|sha256=e98d66992f511ef9b440437b4699d09467572a8fec3452760e7c02cb9392e940",
        identity: "src/tools/tool-args-display.ts#safeValidateSync[AsExpression]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 46,
          column: 20,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fplugins%2Fbuiltin%2Flocal-tools.ts%23createLocalToolSpecs.editTargets%5BAsExpression%5D%401|sha256=b4ace8b75305cf665b270599347805096b0a6f865ed11915ab62c80a81aeec24",
        identity:
          "src/plugins/builtin/local-tools.ts#createLocalToolSpecs.editTargets[AsExpression]@1",
        location: {
          file: "src/plugins/builtin/local-tools.ts",
          line: 278,
          column: 24,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fplugins%2Fbuiltin%2Flocal-tools.ts%23createLocalToolSpecs.editTargets%5BAsExpression%5D%402|sha256=849f95ec508edd67ebdd128d4ad5389027eda25fa04695ed8bc381b9d1ff0005",
        identity:
          "src/plugins/builtin/local-tools.ts#createLocalToolSpecs.editTargets[AsExpression]@2",
        location: {
          file: "src/plugins/builtin/local-tools.ts",
          line: 292,
          column: 24,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftool-server%2Ftools%2Fzod-cli.ts%23getObjectShape%5BAsExpression%5D%401|sha256=f9328f5da0863b77f9f0f0225ba138821a045b897e9550787fd8c09ea84eab69",
        identity: "src/tool-server/tools/zod-cli.ts#getObjectShape[AsExpression]@1",
        location: {
          file: "src/tool-server/tools/zod-cli.ts",
          line: 250,
          column: 11,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftool-server%2Ftools%2Fsurface.ts%23hasGuildIdResolver%5BAsExpression%5D%401|sha256=9d2fcbda2fa6ae513b22a61a6aeb9346d02bcb0d90e64a2f46427c5e95fe2abd",
        identity: "src/tool-server/tools/surface.ts#hasGuildIdResolver[AsExpression]@1",
        location: {
          file: "src/tool-server/tools/surface.ts",
          line: 391,
          column: 13,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftool-server%2Ftools%2Fsurface.ts%23hasReactionDetailsProvider%5BAsExpression%5D%401|sha256=24a8fd5aa261ec3bcf1864801fc16228d9835a066daee7f401775f28b4fefd2c",
        identity: "src/tool-server/tools/surface.ts#hasReactionDetailsProvider[AsExpression]@1",
        location: {
          file: "src/tool-server/tools/surface.ts",
          line: 400,
          column: 13,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Ftool-server%2Ftools%2Fsurface.ts%23hasSessionParticipantsProvider%5BAsExpression%5D%401|sha256=2db7009e4213286735100597af4a67dee6b31da6cac4d60e721f0c99121bdf94",
        identity: "src/tool-server/tools/surface.ts#hasSessionParticipantsProvider[AsExpression]@1",
        location: {
          file: "src/tool-server/tools/surface.ts",
          line: 410,
          column: 7,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unknown-assertion|identity=src%2Fruntime%2Fgraceful-restart-store.ts%23SqliteGracefulRestartStore.loadAndConsumeCompletedSnapshotDetailed%5BAsExpression%5D%401|sha256=a7a14e9fb0c48ee4b6c3c75632a800f1338f9d765cdff4e44c465dc4a48ad76a",
        identity:
          "src/runtime/graceful-restart-store.ts#SqliteGracefulRestartStore.loadAndConsumeCompletedSnapshotDetailed[AsExpression]@1",
        location: {
          file: "src/runtime/graceful-restart-store.ts",
          line: 76,
          column: 19,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
    ],
    "architecture/no-domain-unknown": [
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fshared%2Fsqlite.ts%23isSqliteBusyError%5BParameter%5D%401|sha256=5e4f5b033ce8b5e170990c119279ddadfccaa1796888d6db34edabc62dcb95aa",
        identity: "src/shared/sqlite.ts#isSqliteBusyError[Parameter]@1",
        location: {
          file: "src/shared/sqlite.ts",
          line: 9,
          column: 35,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Foutput%2Fmarkdown-index.ts%23collectAstUnsafeZones%5BParameter%5D%401|sha256=d517aa3b6c8f27f1c555df5fcf0a5d8196ab6ad3940df3893a4a7e8f87de8c3b",
        identity: "src/surface/discord/output/markdown-index.ts#collectAstUnsafeZones[Parameter]@1",
        location: {
          file: "src/surface/discord/output/markdown-index.ts",
          line: 159,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-channel-guards.ts%23%3Cmodule%3E%5BParameter%5D%401|sha256=a7c095200399f572f3217a1455a32722f943462b997f29a77c58947cddf30261",
        identity: "src/surface/discord/discord-channel-guards.ts#<module>[Parameter]@1",
        location: {
          file: "src/surface/discord/discord-channel-guards.ts",
          line: 30,
          column: 8,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-channel-guards.ts%23isTextSendableChannel%5BParameter%5D%401|sha256=d75621748a611193a2c20c816580ce481a36323f11c648af9b6573f006b1752f",
        identity:
          "src/surface/discord/discord-channel-guards.ts#isTextSendableChannel[Parameter]@1",
        location: {
          file: "src/surface/discord/discord-channel-guards.ts",
          line: 33,
          column: 39,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-embed-text.ts%23asNonEmptyString%5BParameter%5D%401|sha256=b6a7ba4afb3641a74e2d0b2fc822684c9381aab6bb804f5234c009713696ae4f",
        identity: "src/surface/discord/discord-embed-text.ts#asNonEmptyString[Parameter]@1",
        location: {
          file: "src/surface/discord/discord-embed-text.ts",
          line: 16,
          column: 27,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-embed-text.ts%23normalizeDiscordEmbedFields%5BParameter%5D%401|sha256=70279ac832424af2871e80b67684916c33a3b7200c3d02f367f1d1eea2efc0ca",
        identity:
          "src/surface/discord/discord-embed-text.ts#normalizeDiscordEmbedFields[Parameter]@1",
        location: {
          file: "src/surface/discord/discord-embed-text.ts",
          line: 21,
          column: 38,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-embed-text.ts%23normalizeDiscordEmbed%5BParameter%5D%401|sha256=6c8d2b231ee203d686095102f6af5df0291afbd765539829079845007e5ee1b6",
        identity: "src/surface/discord/discord-embed-text.ts#normalizeDiscordEmbed[Parameter]@1",
        location: {
          file: "src/surface/discord/discord-embed-text.ts",
          line: 38,
          column: 32,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-embed-text.ts%23normalizeDiscordEmbeds%5BParameter%5D%401|sha256=d811c315c91166d44ed9a2fe3590344a4c0ec53b719931b82f461ef12c2c9366",
        identity: "src/surface/discord/discord-embed-text.ts#normalizeDiscordEmbeds[Parameter]@1",
        location: {
          file: "src/surface/discord/discord-embed-text.ts",
          line: 72,
          column: 40,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-message-meta.ts%23toDiscordAttachmentMeta%5BParameter%5D%401|sha256=7bac05d35ebc8455f2ed3386efd629dc62557988a2cfa9230e201d82e471d107",
        identity:
          "src/surface/discord/discord-message-meta.ts#toDiscordAttachmentMeta[Parameter]@1",
        location: {
          file: "src/surface/discord/discord-message-meta.ts",
          line: 131,
          column: 34,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-message-meta.ts%23collectDiscordAttachmentMeta%5BParameter%5D%401|sha256=77e37bea104ec08d53645694af1310f342faa8839f446c812fe32da499c6925d",
        identity:
          "src/surface/discord/discord-message-meta.ts#collectDiscordAttachmentMeta[Parameter]@1",
        location: {
          file: "src/surface/discord/discord-message-meta.ts",
          line: 158,
          column: 46,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-message-meta.ts%23normalizeFlagsNumber%5BParameter%5D%401|sha256=f32241cef6bba98baf0be61083f1c504ad7866542cdb7f74883e5a790b14dfd9",
        identity: "src/surface/discord/discord-message-meta.ts#normalizeFlagsNumber[Parameter]@1",
        location: {
          file: "src/surface/discord/discord-message-meta.ts",
          line: 188,
          column: 31,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fcustom-commands%2Fmanager.ts%23validateArgChoice%5BParameter%5D%401|sha256=5700455c40ae621a4d9eb26ceda17d2ce42dc747044e74a24ed04ccd01f6dd3e",
        identity: "src/custom-commands/manager.ts#validateArgChoice[Parameter]@1",
        location: {
          file: "src/custom-commands/manager.ts",
          line: 16,
          column: 54,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-request-router%2Fcommon.ts%23getDiscordFlags%5BParameter%5D%401|sha256=adfdfd9a2043af3d93d16dd91de89ac125db41de511abb41b3506f9a3a60cf26",
        identity: "src/surface/bridge/bus-request-router/common.ts#getDiscordFlags[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-request-router/common.ts",
          line: 368,
          column: 33,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-request-router%2Fcommon.ts%23isConfigRecord%5BParameter%5D%401|sha256=b5c575944cc77964f3bd702d09a41719478dfd60c549e3c693b08ff6623ed031",
        identity: "src/surface/bridge/bus-request-router/common.ts#isConfigRecord[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-request-router/common.ts",
          line: 397,
          column: 25,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-adapter.ts%23discordNotFoundCode%5BParameter%5D%401|sha256=d65297edc05833bc180c5b1c28a4353f600b99f80dcc1c22aec25f3af145735f",
        identity: "src/surface/discord/discord-adapter.ts#discordNotFoundCode[Parameter]@1",
        location: {
          file: "src/surface/discord/discord-adapter.ts",
          line: 77,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-adapter.ts%23classifyDiscordSurfaceNotFound%5BParameter%5D%401|sha256=4d093fdfa734879182250fc3353754494ab5dbbd57a79f9fd7a844b4e5792f56",
        identity:
          "src/surface/discord/discord-adapter.ts#classifyDiscordSurfaceNotFound[Parameter]@1",
        location: {
          file: "src/surface/discord/discord-adapter.ts",
          line: 83,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-adapter.ts%23DiscordAdapter.connect.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%401|sha256=190fa0b00e6847343d6ae9fba29cbdb58295042f15f8facd53e92c8b27ba6fd4",
        identity:
          "src/surface/discord/discord-adapter.ts#DiscordAdapter.connect.<callback>.<callback>[Parameter]@1",
        location: {
          file: "src/surface/discord/discord-adapter.ts",
          line: 402,
          column: 49,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-adapter.ts%23DiscordAdapter.editMsg.%3Ccallback%3E%5BParameter%5D%401|sha256=1c50534a567555833679a11589c7ceeb3d722074056964b3f7959030d9a78f48",
        identity:
          "src/surface/discord/discord-adapter.ts#DiscordAdapter.editMsg.<callback>[Parameter]@1",
        location: {
          file: "src/surface/discord/discord-adapter.ts",
          line: 890,
          column: 74,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-adapter.ts%23DiscordAdapter.editMsg.%3Ccallback%3E%5BParameter%5D%402|sha256=bb6ad84017c41d147d94f983722fcfe5e6700fa59f44990d7ef019087842f5e5",
        identity:
          "src/surface/discord/discord-adapter.ts#DiscordAdapter.editMsg.<callback>[Parameter]@2",
        location: {
          file: "src/surface/discord/discord-adapter.ts",
          line: 906,
          column: 71,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-adapter.ts%23DiscordAdapter.registerSlashCommands.%3Ccallback%3E%5BParameter%5D%401|sha256=03b2e7c42783958ec9f0b01c1d533fa17486f1dc1074f858e26025d60b3adc9f",
        identity:
          "src/surface/discord/discord-adapter.ts#DiscordAdapter.registerSlashCommands.<callback>[Parameter]@1",
        location: {
          file: "src/surface/discord/discord-adapter.ts",
          line: 1839,
          column: 44,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-adapter.ts%23DiscordAdapter.registerSlashCommands.%3Ccallback%3E%5BParameter%5D%402|sha256=b8560e48b48b76bc40a0eba3a2857d75bf25750c6c9c8f0b66073f388cc5e649",
        identity:
          "src/surface/discord/discord-adapter.ts#DiscordAdapter.registerSlashCommands.<callback>[Parameter]@2",
        location: {
          file: "src/surface/discord/discord-adapter.ts",
          line: 1856,
          column: 43,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-adapter.ts%23DiscordAdapter.fetchDiscordMessage.%3Ccallback%3E%5BParameter%5D%401|sha256=3f4153281bcd69e6cf8a9a32afa0fd9eccf1fbd1f1091475c5dc75bef37ac8d8",
        identity:
          "src/surface/discord/discord-adapter.ts#DiscordAdapter.fetchDiscordMessage.<callback>[Parameter]@1",
        location: {
          file: "src/surface/discord/discord-adapter.ts",
          line: 2150,
          column: 68,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-adapter.ts%23DiscordAdapter.fetchDiscordMessage.%3Ccallback%3E%5BParameter%5D%402|sha256=d1b00c958f17f3257d9e5b74a083db43edf5de306b0d018a58dd53b587215d70",
        identity:
          "src/surface/discord/discord-adapter.ts#DiscordAdapter.fetchDiscordMessage.<callback>[Parameter]@2",
        location: {
          file: "src/surface/discord/discord-adapter.ts",
          line: 2156,
          column: 65,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.parseCompleteCorePrimaryLineage%5BParameter%5D%401|sha256=df6d5ebcc50b661f4c5a2896e335aa8e3eff8b283c2dca92cb3acaa8d8d84414",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.parseCompleteCorePrimaryLineage[Parameter]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1899,
          column: 43,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftranscript%2Ftranscript-store.ts%23parseNormalizedCanonicalMessages%5BParameter%5D%401|sha256=58e20ac08050d7ca4fc07c02bfd68a7190a4022e3735de11139fd84e68ce2550",
        identity:
          "src/transcript/transcript-store.ts#parseNormalizedCanonicalMessages[Parameter]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3802,
          column: 43,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fgithub%2Fgithub-app-token.ts%23parseExpiresAtMs%5BParameter%5D%401|sha256=1bc7c13474647b72e8a73851b18ff267f72c1f51a3bb3ecfceb79ad4430d0f0f",
        identity: "src/github/github-app-token.ts#parseExpiresAtMs[Parameter]@1",
        location: {
          file: "src/github/github-app-token.ts",
          line: 31,
          column: 27,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fsubscribe-from-bus.ts%23toMsgRefFromSurfaceMsgRef%5BParameter%5D%401|sha256=63618f1d325a55c5eda24bec3b8e64a3d05c0d6c11a331de5d65023e12ebf895",
        identity: "src/surface/bridge/subscribe-from-bus.ts#toMsgRefFromSurfaceMsgRef[Parameter]@1",
        location: {
          file: "src/surface/bridge/subscribe-from-bus.ts",
          line: 208,
          column: 36,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fsubscribe-from-bus.ts%23bridgeBusToAdapter.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%401|sha256=b11e2b4bcb4d3509158170339461f27ac045adb52accd1ff8a3ce04331a1339a",
        identity:
          "src/surface/bridge/subscribe-from-bus.ts#bridgeBusToAdapter.<callback>.<callback>[Parameter]@1",
        location: {
          file: "src/surface/bridge/subscribe-from-bus.ts",
          line: 351,
          column: 35,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fsubscribe-from-bus.ts%23bridgeBusToAdapter.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%402|sha256=dcb2ad82a0d4410a9c5d2d69518315e6afeaffc63473ab76c5cce974067b1f90",
        identity:
          "src/surface/bridge/subscribe-from-bus.ts#bridgeBusToAdapter.<callback>.<callback>[Parameter]@2",
        location: {
          file: "src/surface/bridge/subscribe-from-bus.ts",
          line: 417,
          column: 17,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fsubscribe-from-bus.ts%23bridgeBusToAdapter.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%403|sha256=68fb941c0e30b9906ab54ebaa1c294b6426dc0376f0b81293f09a7cc84b77a79",
        identity:
          "src/surface/bridge/subscribe-from-bus.ts#bridgeBusToAdapter.<callback>.<callback>[Parameter]@3",
        location: {
          file: "src/surface/bridge/subscribe-from-bus.ts",
          line: 485,
          column: 45,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fsubscribe-from-bus.ts%23bridgeBusToAdapter.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%404|sha256=ae3589530ae4c7ceb7ed35c02db45a9bef7bc2f6b84ef6916057df64cc66f0cc",
        identity:
          "src/surface/bridge/subscribe-from-bus.ts#bridgeBusToAdapter.<callback>.<callback>[Parameter]@4",
        location: {
          file: "src/surface/bridge/subscribe-from-bus.ts",
          line: 563,
          column: 41,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fsubscribe-from-bus.ts%23bridgeBusToAdapter.startRelay.publishCreatedForToken.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%401|sha256=2b601b9fe33d4ebc6aba9c39d25c30ec7b9277ba9a77a5cfe1ddbf3247c99340",
        identity:
          "src/surface/bridge/subscribe-from-bus.ts#bridgeBusToAdapter.startRelay.publishCreatedForToken.<callback>.<callback>[Parameter]@1",
        location: {
          file: "src/surface/bridge/subscribe-from-bus.ts",
          line: 721,
          column: 17,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fsubscribe-from-bus.ts%23bridgeBusToAdapter.startRelay.%3Ccallback%3E%5BParameter%5D%401|sha256=e1aae4fd83da49fbd8c1138ee8be55e19d55235fd4f8a4467a90b0b8a95fd66f",
        identity:
          "src/surface/bridge/subscribe-from-bus.ts#bridgeBusToAdapter.startRelay.<callback>[Parameter]@1",
        location: {
          file: "src/surface/bridge/subscribe-from-bus.ts",
          line: 777,
          column: 19,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fsubscribe-from-bus.ts%23bridgeBusToAdapter.startRelay.bumpTimeout.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%401|sha256=8a500991ca327516951b9993cbd2061c87bd0b5d055d9d5cda85d97e6755ebc0",
        identity:
          "src/surface/bridge/subscribe-from-bus.ts#bridgeBusToAdapter.startRelay.bumpTimeout.<callback>.<callback>[Parameter]@1",
        location: {
          file: "src/surface/bridge/subscribe-from-bus.ts",
          line: 882,
          column: 37,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fsubscribe-from-bus.ts%23bridgeBusToAdapter.startRelay.bumpTimeout.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%402|sha256=e20e2816a8bc1c0e9bd367d17cb4e03ba21009cebf49a0db7841655f36b7d3ac",
        identity:
          "src/surface/bridge/subscribe-from-bus.ts#bridgeBusToAdapter.startRelay.bumpTimeout.<callback>.<callback>[Parameter]@2",
        location: {
          file: "src/surface/bridge/subscribe-from-bus.ts",
          line: 885,
          column: 28,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fsubscribe-from-bus.ts%23bridgeBusToAdapter.startRelay.deleteCreatedOutputMessages.%3Ccallback%3E%5BParameter%5D%401|sha256=c331ba7653b151aec7ace58d59909387cc9b9196ce597192508d76d62e9d7f9e",
        identity:
          "src/surface/bridge/subscribe-from-bus.ts#bridgeBusToAdapter.startRelay.deleteCreatedOutputMessages.<callback>[Parameter]@1",
        location: {
          file: "src/surface/bridge/subscribe-from-bus.ts",
          line: 903,
          column: 45,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fsubscribe-from-bus.ts%23bridgeBusToAdapter.startRelay.%3Ccallback%3E.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%401|sha256=a85c5c656af191de349c6842c70cd1599aa9c48691e612363fc6034cd0bc0a4c",
        identity:
          "src/surface/bridge/subscribe-from-bus.ts#bridgeBusToAdapter.startRelay.<callback>.<callback>.<callback>[Parameter]@1",
        location: {
          file: "src/surface/bridge/subscribe-from-bus.ts",
          line: 1217,
          column: 85,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fsubscribe-from-bus.ts%23bridgeBusToAdapter.startRelay.%3Ccallback%3E.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%402|sha256=fd6c1eda4f17b9fe6f711376545a63f9720a434e05282be027de1475cb02a3f3",
        identity:
          "src/surface/bridge/subscribe-from-bus.ts#bridgeBusToAdapter.startRelay.<callback>.<callback>.<callback>[Parameter]@2",
        location: {
          file: "src/surface/bridge/subscribe-from-bus.ts",
          line: 1283,
          column: 85,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fsubscribe-from-bus.ts%23bridgeBusToAdapter.startRelay.%3Ccallback%3E.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%403|sha256=3ab514e1585b2c9f23fcfa735075541dbd8310c8f117e1f57309cf4a7c0c8ecb",
        identity:
          "src/surface/bridge/subscribe-from-bus.ts#bridgeBusToAdapter.startRelay.<callback>.<callback>.<callback>[Parameter]@3",
        location: {
          file: "src/surface/bridge/subscribe-from-bus.ts",
          line: 1356,
          column: 83,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fsubscribe-from-bus.ts%23bridgeBusToAdapter.startRelay.cancel.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%401|sha256=c5e6ec19e9dd48fa42b1f599775273ec89bc9e082be7976943daf743e19939c4",
        identity:
          "src/surface/bridge/subscribe-from-bus.ts#bridgeBusToAdapter.startRelay.cancel.<callback>.<callback>[Parameter]@1",
        location: {
          file: "src/surface/bridge/subscribe-from-bus.ts",
          line: 1422,
          column: 44,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-raw-normalizer.ts%23%3Ccallback%3E%5BParameter%5D%401|sha256=891234cf14fc5b8a6e20812fd6e089e5bd5b253528a383aa9580e4179a7400bd",
        identity: "src/surface/discord/discord-raw-normalizer.ts#<callback>[Parameter]@1",
        location: {
          file: "src/surface/discord/discord-raw-normalizer.ts",
          line: 40,
          column: 4,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-raw-normalizer.ts%23%3Ccallback%3E%5BParameter%5D%402|sha256=1379f70a33862a1bd00b1a523f723746c193cbea74abfcb68bcf74aba9121c44",
        identity: "src/surface/discord/discord-raw-normalizer.ts#<callback>[Parameter]@2",
        location: {
          file: "src/surface/discord/discord-raw-normalizer.ts",
          line: 44,
          column: 4,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-raw-normalizer.ts%23parseRecord%5BParameter%5D%401|sha256=a97fa9912767323451bdcec15fb3ebcd8c484445c43c971f5627a388f9da796d",
        identity: "src/surface/discord/discord-raw-normalizer.ts#parseRecord[Parameter]@1",
        location: {
          file: "src/surface/discord/discord-raw-normalizer.ts",
          line: 88,
          column: 22,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-raw-normalizer.ts%23normalizeDiscordAttachment%5BParameter%5D%401|sha256=b89e27d7b62acbb85d69a05a827eb563193bf47e8edb7c3aa53633379fe3c4d8",
        identity:
          "src/surface/discord/discord-raw-normalizer.ts#normalizeDiscordAttachment[Parameter]@1",
        location: {
          file: "src/surface/discord/discord-raw-normalizer.ts",
          line: 93,
          column: 37,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-raw-normalizer.ts%23normalizeDiscordAttachments%5BParameter%5D%401|sha256=8f6b4b31c7089ca1acee4bc6638dfda02a3fe4598bed24445c86338929a2a8ae",
        identity:
          "src/surface/discord/discord-raw-normalizer.ts#normalizeDiscordAttachments[Parameter]@1",
        location: {
          file: "src/surface/discord/discord-raw-normalizer.ts",
          line: 109,
          column: 38,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-raw-normalizer.ts%23firstForwardSnapshotMessage%5BParameter%5D%401|sha256=27aafcac8cc6c7bd5920c836b952609fa2331cf6dd4183b6fdbebc10b14747ef",
        identity:
          "src/surface/discord/discord-raw-normalizer.ts#firstForwardSnapshotMessage[Parameter]@1",
        location: {
          file: "src/surface/discord/discord-raw-normalizer.ts",
          line: 120,
          column: 38,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-raw-normalizer.ts%23normalizeDiscordRaw%5BParameter%5D%401|sha256=0f3f594b3b2a18dc483a07794d606af7674d1958fb3634c25e9474c2823d997d",
        identity: "src/surface/discord/discord-raw-normalizer.ts#normalizeDiscordRaw[Parameter]@1",
        location: {
          file: "src/surface/discord/discord-raw-normalizer.ts",
          line: 144,
          column: 37,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fdiscord%2Fdiscord-surface-display-text.ts%23getDiscordSurfaceTextFromRaw%5BParameter%5D%401|sha256=5f354e8a2ad5dfcc9b91b2c47f0f93c1deb828e6c8721eb24702639c894b6f68",
        identity:
          "src/surface/discord/discord-surface-display-text.ts#getDiscordSurfaceTextFromRaw[Parameter]@1",
        location: {
          file: "src/surface/discord/discord-surface-display-text.ts",
          line: 10,
          column: 46,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fconversation%2Fthread-embedding.ts%23hasEmbeddingModel%5BParameter%5D%401|sha256=e86ea07c6a7ffc946cbee3e15bca4ddd01d4cd132a3978296baf29615efb6186",
        identity: "src/conversation/thread-embedding.ts#hasEmbeddingModel[Parameter]@1",
        location: {
          file: "src/conversation/thread-embedding.ts",
          line: 59,
          column: 28,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fconversation%2Fthread-store.ts%23safeImportance%5BParameter%5D%401|sha256=1d5fb6da7bdbc1c40e687c9621d29f0382546d25bd72f1dc4b5512bf9537e1a7",
        identity: "src/conversation/thread-store.ts#safeImportance[Parameter]@1",
        location: {
          file: "src/conversation/thread-store.ts",
          line: 267,
          column: 25,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fconversation%2Fthread-service.ts%23isSummaryStreamDecodeError%5BParameter%5D%401|sha256=a513efda11bcf38b67f9ed5b33389eb03f31ce7c24d03ae17ae7132b173fe32e",
        identity: "src/conversation/thread-service.ts#isSummaryStreamDecodeError[Parameter]@1",
        location: {
          file: "src/conversation/thread-service.ts",
          line: 876,
          column: 37,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fworkflow-domain.ts%23normalizeWorkflowResourcePolicy%5BParameter%5D%401|sha256=9577c75a744471b8af61409116822d6048b7775cc1fa84b83a48d1ee9cff3985",
        identity: "src/workflow/workflow-domain.ts#normalizeWorkflowResourcePolicy[Parameter]@1",
        location: {
          file: "src/workflow/workflow-domain.ts",
          line: 100,
          column: 49,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseRevision%5BParameter%5D%401|sha256=acc12f61d732cd8b0cc48ae2a3296c7d48f6abc797189777f3e1fbfc7c4bd936",
        identity: "src/workflow/durable-workflow-store.ts#parseRevision[Parameter]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 255,
          column: 24,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseRun%5BParameter%5D%401|sha256=09e67dd2548602f0388beff0b43805516912c253533c9d346d7b5b529ea554be",
        identity: "src/workflow/durable-workflow-store.ts#parseRun[Parameter]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 277,
          column: 19,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseOperation%5BParameter%5D%401|sha256=6bfbec4a908af808002544ec22c0e1de29881947a4aaf74f4c18505e590fcbe5",
        identity: "src/workflow/durable-workflow-store.ts#parseOperation[Parameter]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 310,
          column: 25,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseWait%5BParameter%5D%401|sha256=8cf5eba6a75ecc3254f99b19bb50efb9deb16448580b5216738b5023246d9b65",
        identity: "src/workflow/durable-workflow-store.ts#parseWait[Parameter]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 338,
          column: 20,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseTrigger%5BParameter%5D%401|sha256=63f77586879101cfc7aeb88e8d954f9a30b8bbf1d8f8203b95e4a8ec27a278df",
        identity: "src/workflow/durable-workflow-store.ts#parseTrigger[Parameter]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 359,
          column: 23,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseBinding%5BParameter%5D%401|sha256=d26a40364ead75580fdf24aa69c08b985cb868b081c01a0bea868396ed5e2d04",
        identity: "src/workflow/durable-workflow-store.ts#parseBinding[Parameter]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 391,
          column: 23,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseAction%5BParameter%5D%401|sha256=1c49d77c74007dcd18a2115c7b74b150024d16b535eca09a428758f77d6d5e04",
        identity: "src/workflow/durable-workflow-store.ts#parseAction[Parameter]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 409,
          column: 22,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseRequestTerminalReceipt%5BParameter%5D%401|sha256=bbc02db2d6f343bcfbb199467bbfb0a66e66014b6537f5fe9286db3484c33074",
        identity: "src/workflow/durable-workflow-store.ts#parseRequestTerminalReceipt[Parameter]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 430,
          column: 38,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseActionOutboxEntry%5BParameter%5D%401|sha256=6df01fe2def17b1b0d43bd214c5317edb6e68bb58b007d063fa59e12838d9f58",
        identity: "src/workflow/durable-workflow-store.ts#parseActionOutboxEntry[Parameter]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 456,
          column: 33,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23tolerantRows%5BParameter%5D%401|sha256=07f0e635c1e5ac322131d5e66eae55278db584cff0728f592e0a95bbe92c7d8e",
        identity: "src/workflow/durable-workflow-store.ts#tolerantRows[Parameter]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 474,
          column: 60,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23tolerantRows.%3Ccallback%3E%5BParameter%5D%401|sha256=c056d6b96334d90e98d1fca1f3f8be939e0e0d8637b4c718fe542dadaefb3d33",
        identity: "src/workflow/durable-workflow-store.ts#tolerantRows.<callback>[Parameter]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 475,
          column: 24,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.listMigrations.%3Ccallback%3E%5BParameter%5D%401|sha256=168760ecb03cff42dfee965f5030678a1b3b193dc3ba6267e29265f3ba9d92af",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.listMigrations.<callback>[Parameter]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 650,
          column: 13,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.summarizeMeaningfulOperations.%3Ccallback%3E%5BParameter%5D%401|sha256=65e5383e632e2949858b17a7741ab51f05138182c600b143a633b287c74777f2",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.summarizeMeaningfulOperations.<callback>[Parameter]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 2236,
          column: 32,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fgithub%2Fgithub-adapter.ts%23isGithubCommentAuthoredByActor%5BParameter%5D%401|sha256=d648ea9a0793e49ca23feeb89df58c25887598426fb18c014fc9ab70940b9313",
        identity:
          "src/surface/github/github-adapter.ts#isGithubCommentAuthoredByActor[Parameter]@1",
        location: {
          file: "src/surface/github/github-adapter.ts",
          line: 49,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fgithub%2Fgithub-adapter.ts%23GithubAdapter.readMsg.%3Ccallback%3E%5BParameter%5D%401|sha256=eff0de92c7bcfafd3697f598545a500c89a9dbd9d09a98baa2b79651e00927a3",
        identity:
          "src/surface/github/github-adapter.ts#GithubAdapter.readMsg.<callback>[Parameter]@1",
        location: {
          file: "src/surface/github/github-adapter.ts",
          line: 179,
          column: 17,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fgithub%2Fgithub-adapter.ts%23GithubAdapter.readMsg.%3Ccallback%3E%5BParameter%5D%402|sha256=08a3c452fec49e173f67eeef282ad1e17c33a0c14621cb4a3f6ea7e8925007e3",
        identity:
          "src/surface/github/github-adapter.ts#GithubAdapter.readMsg.<callback>[Parameter]@2",
        location: {
          file: "src/surface/github/github-adapter.ts",
          line: 201,
          column: 15,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fgithub%2Fgithub-adapter.ts%23GithubMessageCreatedError.constructor%5BParameter%5D%401|sha256=4b0bcb5f74b7b4f3325b7fd356d5db5d0f000d6cad8f0c101748cbc2cf176898",
        identity:
          "src/surface/github/github-adapter.ts#GithubMessageCreatedError.constructor[Parameter]@1",
        location: {
          file: "src/surface/github/github-adapter.ts",
          line: 317,
          column: 5,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fworkflow-progress-projector.ts%23WorkflowProgressProjector.requestProjection.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%401|sha256=f39014aa4cb3d58475e4e9bc071d329dfd1b5479fd88358737e1faa84b28c1cc",
        identity:
          "src/workflow/workflow-progress-projector.ts#WorkflowProgressProjector.requestProjection.<callback>.<callback>[Parameter]@1",
        location: {
          file: "src/workflow/workflow-progress-projector.ts",
          line: 155,
          column: 41,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fworkflow-progress-projector.ts%23WorkflowProgressProjector.reconcile.%3Ccallback%3E%5BParameter%5D%401|sha256=16c08021245ccecb65a9f2c9cafafc85c036d80c493ea1fa13426665ee84a7f1",
        identity:
          "src/workflow/workflow-progress-projector.ts#WorkflowProgressProjector.reconcile.<callback>[Parameter]@1",
        location: {
          file: "src/workflow/workflow-progress-projector.ts",
          line: 178,
          column: 57,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fworkflow-progress-projector.ts%23WorkflowProgressProjector.writeFailure%5BParameter%5D%401|sha256=bdd9cf4a2944f1822be41af2fb93b426132603c2bc01307f13dedefe071ed4ff",
        identity:
          "src/workflow/workflow-progress-projector.ts#WorkflowProgressProjector.writeFailure[Parameter]@1",
        location: {
          file: "src/workflow/workflow-progress-projector.ts",
          line: 301,
          column: 5,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fmcp%2Fconfig.ts%23parseMcpConfigDocument%5BParameter%5D%401|sha256=a61e1217f869dc9f25144e6fab497f017c88b86edcac48dcaddae2dc31e20d8f",
        identity: "src/mcp/config.ts#parseMcpConfigDocument[Parameter]@1",
        location: {
          file: "src/mcp/config.ts",
          line: 200,
          column: 40,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fssh%2Fssh-exec.ts%23isResponseBodyInit%5BParameter%5D%401|sha256=8c105de64bd34156e22222c49cd9819c6a2e28c752a79d4e896c6989995ede3f",
        identity: "src/ssh/ssh-exec.ts#isResponseBodyInit[Parameter]@1",
        location: {
          file: "src/ssh/ssh-exec.ts",
          line: 41,
          column: 29,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fssh%2Fssh-exec.ts%23readStreamTextCapped%5BParameter%5D%401|sha256=df2200d8b59bad9381747845942800bfdf18d1d7092cef0f2b7fa2bd1dfef869",
        identity: "src/ssh/ssh-exec.ts#readStreamTextCapped[Parameter]@1",
        location: {
          file: "src/ssh/ssh-exec.ts",
          line: 54,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Fbatch-error-message.ts%23summarizeProvidedKeys%5BParameter%5D%401|sha256=12e310cbfa16789753b37375abfeaff464a205a0f4a42e8568b3410298d4d166",
        identity: "src/tools/batch-error-message.ts#summarizeProvidedKeys[Parameter]@1",
        location: {
          file: "src/tools/batch-error-message.ts",
          line: 29,
          column: 32,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Fbatch-error-message.ts%23isEmptyObjectParameters%5BParameter%5D%401|sha256=2b02a07cef24d8b8f345b8549b28c5addbf1ec5916a2c359a38da0bf28e60df8",
        identity: "src/tools/batch-error-message.ts#isEmptyObjectParameters[Parameter]@1",
        location: {
          file: "src/tools/batch-error-message.ts",
          line: 39,
          column: 34,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Fbash-output-sanitizer.ts%23isResponseBodyInit%5BParameter%5D%401|sha256=f8b8efe77f8c726cce805db7880585dcc0e2aa2804edd9fc13a070eccee62dc0",
        identity: "src/tools/bash-output-sanitizer.ts#isResponseBodyInit[Parameter]@1",
        location: {
          file: "src/tools/bash-output-sanitizer.ts",
          line: 314,
          column: 29,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Fbash-output-sanitizer.ts%23readSanitizedStreamTextCapped%5BParameter%5D%401|sha256=6f0646e568edef1b24b71c3eafef31aad3bbc0ecb82e2c8eb76d718a49d4e5a1",
        identity: "src/tools/bash-output-sanitizer.ts#readSanitizedStreamTextCapped[Parameter]@1",
        location: {
          file: "src/tools/bash-output-sanitizer.ts",
          line: 327,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-env.ts%23parseEntry%5BParameter%5D%401|sha256=f5e2dcf03a33f0a4432d05bbe847ab96fb9b100f2790ed5108c7b7563a86237d",
        identity: "src/tools/tool-env.ts#parseEntry[Parameter]@1",
        location: {
          file: "src/tools/tool-env.ts",
          line: 55,
          column: 35,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-env.ts%23parseToolEnv%5BParameter%5D%401|sha256=872ca20c30e4e3825d33b593afbdd6274db1832deadadc685f3e05b57180ab90",
        identity: "src/tools/tool-env.ts#parseToolEnv[Parameter]@1",
        location: {
          file: "src/tools/tool-env.ts",
          line: 71,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Fbash-impl.ts%23toErrorMessage%5BParameter%5D%401|sha256=d56ff8fc1412c43f09f8837ef4dc4b066a9d7b011be202c69776aabca90d1cce",
        identity: "src/tools/bash-impl.ts#toErrorMessage[Parameter]@1",
        location: {
          file: "src/tools/bash-impl.ts",
          line: 108,
          column: 25,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Frestricted-bash.ts%23RestrictedReadFs.assertReadable.%3Ccallback%3E%5BParameter%5D%401|sha256=6f0497c91b26d3a0ad350f9a0c80cf7e2d16c1d4b6625c0ea9f474d4c2c64cc4",
        identity:
          "src/tools/restricted-bash.ts#RestrictedReadFs.assertReadable.<callback>[Parameter]@1",
        location: {
          file: "src/tools/restricted-bash.ts",
          line: 92,
          column: 51,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Frestricted-bash.ts%23RestrictedReadFs.assertWritable.%3Ccallback%3E%5BParameter%5D%401|sha256=a739fcfca317f745b5ab9bcbf9d5b72ff073fe4674eab98d8b7bd35783a9e599",
        identity:
          "src/tools/restricted-bash.ts#RestrictedReadFs.assertWritable.<callback>[Parameter]@1",
        location: {
          file: "src/tools/restricted-bash.ts",
          line: 112,
          column: 51,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Frestricted-bash.ts%23formatToolOutput%5BParameter%5D%401|sha256=c3c2f2083c7fa2c6acda5cc77c653c3bc415c28bf025b7cebc45883f5f4bb22e",
        identity: "src/tools/restricted-bash.ts#formatToolOutput[Parameter]@1",
        location: {
          file: "src/tools/restricted-bash.ts",
          line: 271,
          column: 27,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ffs%2Ffs.ts%23truncateSearchEntryStrings%5BParameter%5D%401|sha256=6fa918ed6c7eead08ac9a5c2268180a22dcbf56d59030ceea4283674ffe456da",
        identity: "src/tools/fs/fs.ts#truncateSearchEntryStrings[Parameter]@1",
        location: {
          file: "src/tools/fs/fs.ts",
          line: 382,
          column: 37,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ffs%2Ffs.ts%23boundSearchOutput.serializedBytes%5BParameter%5D%401|sha256=8aa347b6f7a5cd652bd3315cf5d6e87c9cd6101e3af6e7a42798209b53dbc72e",
        identity: "src/tools/fs/fs.ts#boundSearchOutput.serializedBytes[Parameter]@1",
        location: {
          file: "src/tools/fs/fs.ts",
          line: 406,
          column: 28,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fshared%2Fis-adapter-platform.ts%23isAdapterPlatform%5BParameter%5D%401|sha256=2f4ab79a4e6010dbe2df724bcd0cfdf8beba897d730f7feb77fa8a7e0a61cf07",
        identity: "src/shared/is-adapter-platform.ts#isAdapterPlatform[Parameter]@1",
        location: {
          file: "src/shared/is-adapter-platform.ts",
          line: 3,
          column: 35,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fshared%2Freq-context.ts%23requireRequestContext%5BParameter%5D%401|sha256=cbb9e1a1f12f7e3841f90f5291dd83e3a71ae3eb04b646e85167b58b444c5d00",
        identity: "src/shared/req-context.ts#requireRequestContext[Parameter]@1",
        location: {
          file: "src/shared/req-context.ts",
          line: 10,
          column: 39,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Fsubagent.ts%23parseDepth%5BParameter%5D%401|sha256=1bd25af2a8883cf88cbfded54251d8a5da7647fb8cd4e854ab1996b7ba97e0e0",
        identity: "src/tools/subagent.ts#parseDepth[Parameter]@1",
        location: {
          file: "src/tools/subagent.ts",
          line: 101,
          column: 21,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Fsubagent.ts%23parseCurrentRunProfile%5BParameter%5D%401|sha256=6474aadc9a4209a7435700abc6d8657fb55813204c55810b1b2b84ee7b2121a6",
        identity: "src/tools/subagent.ts#parseCurrentRunProfile[Parameter]@1",
        location: {
          file: "src/tools/subagent.ts",
          line: 116,
          column: 33,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Ftool-failure-logging.ts%23isRecord%5BParameter%5D%401|sha256=7a5519c9cd1005f4b51bd082c312aaf545e925c41e5d49e32c5082a7951ba9d2",
        identity:
          "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts#isRecord[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts",
          line: 27,
          column: 19,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Ftool-failure-logging.ts%23getStringField%5BParameter%5D%401|sha256=497ec748951a87604445cea97ea710be489a5d25c85dada07b7babe4616ae970",
        identity:
          "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts#getStringField[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts",
          line: 31,
          column: 25,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Ftool-failure-logging.ts%23getNumberField%5BParameter%5D%401|sha256=4833b6bf2f1d16a9bb09a405d8d255956d80d35d44e2931ffa985406ec5e0ff5",
        identity:
          "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts#getNumberField[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts",
          line: 37,
          column: 25,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Ftool-failure-logging.ts%23getBooleanField%5BParameter%5D%401|sha256=f10aea6f98f5f7f4257181548a64b1e550075b0f651c761d2a60e84755f18199",
        identity:
          "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts#getBooleanField[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts",
          line: 43,
          column: 26,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Ftool-failure-logging.ts%23toSerializablePreview%5BParameter%5D%401|sha256=fac51ec57837442ce79bb2c61b866ffbed451b12de6f3836c9260b5fae1c35e2",
        identity:
          "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts#toSerializablePreview[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts",
          line: 49,
          column: 32,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Ftool-failure-logging.ts%23defaultErrorFromResult%5BParameter%5D%401|sha256=a2aa6d40c2bdac77a9f8e17e3b7d933eca939361e3c9fbe9be3735e5a2dddd65",
        identity:
          "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts#defaultErrorFromResult[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts",
          line: 90,
          column: 33,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Ftool-failure-logging.ts%23summarizeBashFailure%5BParameter%5D%401|sha256=16924d4ab4ffddd84acd52e0a3c7abce840cf905a6a4f4608e7cfbb21cf3b7ab",
        identity:
          "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts#summarizeBashFailure[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts",
          line: 100,
          column: 31,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Ftool-failure-logging.ts%23summarizeReadOrEditFailure%5BParameter%5D%401|sha256=ff3b2db8f27f046f3f9660e35293ec29b38236ef5225c7858eb9bdba43a5cc79",
        identity:
          "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts#summarizeReadOrEditFailure[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts",
          line: 123,
          column: 37,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Ftool-failure-logging.ts%23summarizeSearchFailure%5BParameter%5D%401|sha256=fbbfe2e631ec6c1731fa00f3dfec0af51c4e494163cb4a3b006b01b2264b4bed",
        identity:
          "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts#summarizeSearchFailure[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts",
          line: 137,
          column: 33,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Ftool-failure-logging.ts%23summarizeApplyPatchFailure%5BParameter%5D%401|sha256=b8924481f22bceffc6461f7a9573891b4ec06413706215f8410f087805027de1",
        identity:
          "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts#summarizeApplyPatchFailure[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts",
          line: 149,
          column: 37,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Ftool-failure-logging.ts%23summarizeBatchFailure%5BParameter%5D%401|sha256=ab10bc42a848e21cb064e1011ea43d684560d3ccda3ef67eecf83027f9e1d040",
        identity:
          "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts#summarizeBatchFailure[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts",
          line: 162,
          column: 32,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Ftool-failure-logging.ts%23summarizeSubagentFailure%5BParameter%5D%401|sha256=c77cc60c5fb938f0de2e2428eb41eb9d5e3a78348f5d68cb446f2742576444da",
        identity:
          "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts#summarizeSubagentFailure[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts",
          line: 178,
          column: 35,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Ftool-failure-logging.ts%23%3Cmodule%3E%5BParameter%5D%401|sha256=c8d450ad196f2d2b4c75afafe6a4d160598fefa9646fb9e7c4b28401cfa4467c",
        identity:
          "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts#<module>[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts",
          line: 194,
          column: 4,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Ftool-failure-logging.ts%23read_file%5BParameter%5D%401|sha256=6c1f334279d1e1cb34c915e2f03d9f4a780b613993c8fea998957f508e35057c",
        identity:
          "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts#read_file[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts",
          line: 197,
          column: 15,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Ftool-failure-logging.ts%23edit_file%5BParameter%5D%401|sha256=424e34b396ce0db5852c2e7fbf6f0c4d77538cf763160290bc7708571a332cdd",
        identity:
          "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts#edit_file[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts",
          line: 198,
          column: 15,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Ftool-failure-logging.ts%23glob%5BParameter%5D%401|sha256=a3afc5b03fc11ab17dd238967977fe81b3a8fe09a1545f434f47191e6424f670",
        identity: "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts#glob[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts",
          line: 199,
          column: 10,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Ftool-failure-logging.ts%23grep%5BParameter%5D%401|sha256=1940f12129aa5003ec0f65870761e4c8c806e6a121a6877513c20474bc02fa3b",
        identity: "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts#grep[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts",
          line: 200,
          column: 10,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-args-display.ts%23isZodSchema%5BParameter%5D%401|sha256=62f36deb2c4446970aa0dd7e210eef572b37d8106480fef4c1b797a2b89b6bd5",
        identity: "src/tools/tool-args-display.ts#isZodSchema[Parameter]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 12,
          column: 22,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-args-display.ts%23isZodSchema%5BParameter%5D%401|sha256=0d0056655d09754c120dc951c9798993f5f134fc205c7ba00c0f01afbef82e97",
        identity: "src/tools/tool-args-display.ts#isZodSchema[Parameter]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 13,
          column: 15,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-args-display.ts%23isPromiseLike%5BParameter%5D%401|sha256=d51248df5ce62454f023da3802a7024a2f420bcf7696c81af778fb63d527ac56",
        identity: "src/tools/tool-args-display.ts#isPromiseLike[Parameter]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 23,
          column: 24,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-args-display.ts%23safeValidateSync%5BParameter%5D%401|sha256=f0fa52356159025f84da9c28225ca6375b95402a326b6367074123998822fb33",
        identity: "src/tools/tool-args-display.ts#safeValidateSync[Parameter]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 32,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-args-display.ts%23safeValidateSync%5BParameter%5D%401|sha256=17963c500ab3f865c4edf8bea96692f52ae2c6302de4e32c518a3b36f55c07b4",
        identity: "src/tools/tool-args-display.ts#safeValidateSync[Parameter]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 32,
          column: 47,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-args-display.ts%23safeValidateSync%5BParameter%5D%401|sha256=6b15f00f5e2cf04f15011198749c0bae4deb346c7cc5388cc47312511ac5b2a3",
        identity: "src/tools/tool-args-display.ts#safeValidateSync[Parameter]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 43,
          column: 31,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-args-display.ts%23%3Cmodule%3E%5BParameter%5D%401|sha256=a567b83b9d661ffe43ffc81a7cdda94d7dfcfd49dceed7e5846be652daf2e72d",
        identity: "src/tools/tool-args-display.ts#<module>[Parameter]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 106,
          column: 34,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-args-display.ts%23getRecord%5BParameter%5D%401|sha256=4daa1a0b68c71a2a33f7af6983ca86a6fcab75c0f7404311ca6bd2c76605ed5c",
        identity: "src/tools/tool-args-display.ts#getRecord[Parameter]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 138,
          column: 20,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-args-display.ts%23getPathArg%5BParameter%5D%401|sha256=3bc1455db90c7b52e876f965b2bc2ecf6d47cc7181eb7207de3bca99d38af0e3",
        identity: "src/tools/tool-args-display.ts#getPathArg[Parameter]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 143,
          column: 21,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-args-display.ts%23getGlobArgs%5BParameter%5D%401|sha256=beec1eaea806ddceb1a94432994c018d19804b2e7420c7d362c1e673fe838854",
        identity: "src/tools/tool-args-display.ts#getGlobArgs[Parameter]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 148,
          column: 22,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-args-display.ts%23getGrepArgs%5BParameter%5D%401|sha256=d8af2bf01078c0cb316009d6bfa04be32f6bc32e9df8ba96098e8f937b46b5b5",
        identity: "src/tools/tool-args-display.ts#getGrepArgs[Parameter]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 161,
          column: 22,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-args-display.ts%23getFuzzySearchArgs%5BParameter%5D%401|sha256=7920c92009a941bf85b7c52edd44d703e5d473c4cbcde6eb91a9d0066aee2007",
        identity: "src/tools/tool-args-display.ts#getFuzzySearchArgs[Parameter]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 170,
          column: 29,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-args-display.ts%23readFileToolArgsFormatter%5BParameter%5D%401|sha256=760f7cfbe2b4e350bb4946a11128f004067e1209efe4572793e77a40b4f9f448",
        identity: "src/tools/tool-args-display.ts#readFileToolArgsFormatter[Parameter]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 179,
          column: 55,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-args-display.ts%23bash%5BParameter%5D%401|sha256=9d6b2ac846e52d51fbc02c05f8a9375328e5d9d1eddc7ef1bbcac00448d5ed03",
        identity: "src/tools/tool-args-display.ts#bash[Parameter]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 189,
          column: 10,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-args-display.ts%23glob%5BParameter%5D%401|sha256=89ef48b82fbecdb813f18e8f1fbd9f0af88303d3df91f4a04448cf3c47f1363f",
        identity: "src/tools/tool-args-display.ts#glob[Parameter]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 211,
          column: 10,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-args-display.ts%23grep%5BParameter%5D%401|sha256=1514965511f4b9daaf847547258e549cf1b9d788c364349a5e82d911a88a3c32",
        identity: "src/tools/tool-args-display.ts#grep[Parameter]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 227,
          column: 10,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-args-display.ts%23fuzzy_search%5BParameter%5D%401|sha256=63d65ae05ea4fef3360b85bcd810aeae0c1bc30d47fa8d60199281f948766221",
        identity: "src/tools/tool-args-display.ts#fuzzy_search[Parameter]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 241,
          column: 18,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-args-display.ts%23subagent_delegate%5BParameter%5D%401|sha256=db04f6165e5776a62d1c07a6fd012ff57085355f69ba24b06fc675ebce07901c",
        identity: "src/tools/tool-args-display.ts#subagent_delegate[Parameter]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 255,
          column: 23,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-args-display.ts%23apply_patch%5BParameter%5D%401|sha256=6ff609604712a979c5eda139954ed84ebcf16edd6a77e243fd3a554b5bdc1e51",
        identity: "src/tools/tool-args-display.ts#apply_patch[Parameter]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 266,
          column: 17,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-args-display.ts%23edit_file%5BParameter%5D%401|sha256=1cf81ad6e6e471720a3f73ac6e24e97049e8d452de7c5a5cd78e60a0eee612e0",
        identity: "src/tools/tool-args-display.ts#edit_file[Parameter]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 279,
          column: 15,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-args-display.ts%23batch%5BParameter%5D%401|sha256=331c92263f9e8930b9d4172a0eb89268784118b0780a5686f7a53be7e071c7fb",
        identity: "src/tools/tool-args-display.ts#batch[Parameter]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 288,
          column: 11,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-args-display.ts%23formatToolArgsForDisplay%5BParameter%5D%401|sha256=9bf31e09a2e2fd480721a248b97aa623d44ee404878edde28813f227ae710857",
        identity: "src/tools/tool-args-display.ts#formatToolArgsForDisplay[Parameter]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 298,
          column: 60,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Ftool-args-display.ts%23formatToolArgsForDisplayWithSpecs%5BParameter%5D%401|sha256=49f97d08e48a591ae9e1457dbf2353568781c81d794db943d6b2ca6239daec43",
        identity: "src/tools/tool-args-display.ts#formatToolArgsForDisplayWithSpecs[Parameter]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 309,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fplugins%2Fbuiltin%2Flocal-tools.ts%23createLocalToolSpecs.editTargets%5BParameter%5D%401|sha256=f009126a61633f4e8e3bc8d397d05cca909c3991a0d46bf93d004c65b270d14f",
        identity:
          "src/plugins/builtin/local-tools.ts#createLocalToolSpecs.editTargets[Parameter]@1",
        location: {
          file: "src/plugins/builtin/local-tools.ts",
          line: 277,
          column: 21,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fplugins%2Fbuiltin%2Flocal-tools.ts%23createLocalToolSpecs.editTargets%5BParameter%5D%402|sha256=a2b13f90c642a36f70571f76e7d97e7dbfb6d5656daff85320af0249a54330ea",
        identity:
          "src/plugins/builtin/local-tools.ts#createLocalToolSpecs.editTargets[Parameter]@2",
        location: {
          file: "src/plugins/builtin/local-tools.ts",
          line: 291,
          column: 21,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Ftools%2Fzod-cli.ts%23formatValue%5BParameter%5D%401|sha256=92a2af052206c9196fee9c1c54544c4b741e624869194973401dced582d0126c",
        identity: "src/tool-server/tools/zod-cli.ts#formatValue[Parameter]@1",
        location: {
          file: "src/tool-server/tools/zod-cli.ts",
          line: 432,
          column: 22,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Ftools%2Fweb-search%2Ffirecrawl-web-search-provider.ts%23toFirecrawlItems%5BParameter%5D%401|sha256=9004b6883fdfc7bc4a1bfaee9fead183da90eb5e411db74e9912be55065f0c88",
        identity:
          "src/tool-server/tools/web-search/firecrawl-web-search-provider.ts#toFirecrawlItems[Parameter]@1",
        location: {
          file: "src/tool-server/tools/web-search/firecrawl-web-search-provider.ts",
          line: 80,
          column: 27,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Ftools%2Fweb-search%2Ffirecrawl-web-search-provider.ts%23toFirecrawlItems.appendItem%5BParameter%5D%401|sha256=4bd402e312570874496c1883c1fa79310c71578ca2eb2950a50f68ed47283960",
        identity:
          "src/tool-server/tools/web-search/firecrawl-web-search-provider.ts#toFirecrawlItems.appendItem[Parameter]@1",
        location: {
          file: "src/tool-server/tools/web-search/firecrawl-web-search-provider.ts",
          line: 83,
          column: 23,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Ftools%2Fweb-search%2Ffirecrawl-web-search-provider.ts%23toFirecrawlItems.appendMany%5BParameter%5D%401|sha256=34eef362d7d6b36d73d8da99193c479d58aa082106ba6b9f4997016f1756ed9e",
        identity:
          "src/tool-server/tools/web-search/firecrawl-web-search-provider.ts#toFirecrawlItems.appendMany[Parameter]@1",
        location: {
          file: "src/tool-server/tools/web-search/firecrawl-web-search-provider.ts",
          line: 111,
          column: 23,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Ftools%2Fweb.ts%23getErrorStatus%5BParameter%5D%401|sha256=7ab7bc5033743f8f3a27fbdcbc23276c1aff2be07e056b74e5e5dfe33d9fa5ac",
        identity: "src/tool-server/tools/web.ts#getErrorStatus[Parameter]@1",
        location: {
          file: "src/tool-server/tools/web.ts",
          line: 170,
          column: 25,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Ftools%2Fweb.ts%23isRetriableWebProviderError%5BParameter%5D%401|sha256=b2bd6c76126a1359ad4d4e8aca943dc61f1f3256bb3514bec6102b7a39def6c4",
        identity: "src/tool-server/tools/web.ts#isRetriableWebProviderError[Parameter]@1",
        location: {
          file: "src/tool-server/tools/web.ts",
          line: 192,
          column: 38,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Ftools%2Fweb.ts%23Web.callFetch%5BParameter%5D%401|sha256=6234c35c821e77a1a23d1cd247ec40175f507059ed971368a1ce7af1026bdc05",
        identity: "src/tool-server/tools/web.ts#Web.callFetch[Parameter]@1",
        location: {
          file: "src/tool-server/tools/web.ts",
          line: 703,
          column: 5,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Ftools%2Fweb.ts%23Web.callSearch%5BParameter%5D%401|sha256=ca81fe1aa56ec7e44020e839193c2866f04131de2d1f6f4b637555942dc16442",
        identity: "src/tool-server/tools/web.ts#Web.callSearch[Parameter]@1",
        location: {
          file: "src/tool-server/tools/web.ts",
          line: 740,
          column: 5,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Fvalidation-error-message.ts%23summarizeProvidedKeys%5BParameter%5D%401|sha256=8a9b16f24ee1d29c14c400cd81ed37ccaa3c0891ed05ad101784e0df8b54a75b",
        identity: "src/tool-server/validation-error-message.ts#summarizeProvidedKeys[Parameter]@1",
        location: {
          file: "src/tool-server/validation-error-message.ts",
          line: 31,
          column: 32,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Fvalidation-error-message.ts%23isEmptyObjectInput%5BParameter%5D%401|sha256=1c9d718a051945657dbaaefb21ac50ca041e4c34603097a176c1f2537c2f2aea",
        identity: "src/tool-server/validation-error-message.ts#isEmptyObjectInput[Parameter]@1",
        location: {
          file: "src/tool-server/validation-error-message.ts",
          line: 41,
          column: 29,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Ftools%2Fattachment.ts%23normalizeAttachmentAddFilesInput%5BParameter%5D%401|sha256=c9ce24af1229722de7619e9bef04590dcdcb1af6fa4bff934dfcac4d8811c3c5",
        identity:
          "src/tool-server/tools/attachment.ts#normalizeAttachmentAddFilesInput[Parameter]@1",
        location: {
          file: "src/tool-server/tools/attachment.ts",
          line: 48,
          column: 43,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Ftools%2Fattachment.ts%23asBuffer%5BParameter%5D%401|sha256=35818ee5a5b77aca8ffec022ff5d409ef27396aa2fca541817014a3d4eed6f28",
        identity: "src/tool-server/tools/attachment.ts#asBuffer[Parameter]@1",
        location: {
          file: "src/tool-server/tools/attachment.ts",
          line: 66,
          column: 19,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Ftools%2Fattachment.ts%23downloadToBuffer%5BParameter%5D%401|sha256=d57db58675f131b0f9d5200776f81422b193228292dfbaa45e54fdea6a6ca864",
        identity: "src/tool-server/tools/attachment.ts#downloadToBuffer[Parameter]@1",
        location: {
          file: "src/tool-server/tools/attachment.ts",
          line: 83,
          column: 33,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fcron.ts%23toDate%5BParameter%5D%401|sha256=4477049340dfc55a1618f76c6e1c2c446b8c329b17b78800bddedad8bd519c0f",
        identity: "src/workflow/cron.ts#toDate[Parameter]@1",
        location: {
          file: "src/workflow/cron.ts",
          line: 20,
          column: 17,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Ftools%2Fprogrammatic-workflow.ts%23hasSensitiveSchema.visit%5BParameter%5D%401|sha256=dac707fa10b0dc80379e8930755e51c449ef3031305cd6129c4dd6855e2c1771",
        identity:
          "src/tool-server/tools/programmatic-workflow.ts#hasSensitiveSchema.visit[Parameter]@1",
        location: {
          file: "src/tool-server/tools/programmatic-workflow.ts",
          line: 160,
          column: 18,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftranscript%2Fheartbeat-handoff.ts%23extractSurfaceSendTexts%5BParameter%5D%401|sha256=ea92df7f3aea65e084e9fe898c7e52d364076f032b6af7fbe5745eaa82e7ad81",
        identity: "src/transcript/heartbeat-handoff.ts#extractSurfaceSendTexts[Parameter]@1",
        location: {
          file: "src/transcript/heartbeat-handoff.ts",
          line: 126,
          column: 64,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftranscript%2Fheartbeat-handoff.ts%23extractDirectSurfaceSendText%5BParameter%5D%401|sha256=dd0fc3189c61a6095c30d6f91700ac744731a4f2a67384beebab96cb180f8324",
        identity: "src/transcript/heartbeat-handoff.ts#extractDirectSurfaceSendText[Parameter]@1",
        location: {
          file: "src/transcript/heartbeat-handoff.ts",
          line: 161,
          column: 39,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftranscript%2Fheartbeat-handoff.ts%23extractBatchSurfaceSendTexts%5BParameter%5D%401|sha256=ad4763dff72d6d1c6166af68ff1fee5a2fe1894a2ae0e37452a4e1bcfece91ab",
        identity: "src/transcript/heartbeat-handoff.ts#extractBatchSurfaceSendTexts[Parameter]@1",
        location: {
          file: "src/transcript/heartbeat-handoff.ts",
          line: 167,
          column: 39,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftranscript%2Fheartbeat-handoff.ts%23extractCandidateStrings%5BParameter%5D%401|sha256=cd1ca43d1b5a4e47ee944702357b5de1425e9ece0500ab153a2994745df783e8",
        identity: "src/transcript/heartbeat-handoff.ts#extractCandidateStrings[Parameter]@1",
        location: {
          file: "src/transcript/heartbeat-handoff.ts",
          line: 193,
          column: 34,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftranscript%2Fheartbeat-handoff.ts%23safeStringify%5BParameter%5D%401|sha256=3b17bf5ae36ba5690de46edf3d3a666f910ff6f0a3155a10c74131efcd7bce4a",
        identity: "src/transcript/heartbeat-handoff.ts#safeStringify[Parameter]@1",
        location: {
          file: "src/transcript/heartbeat-handoff.ts",
          line: 201,
          column: 24,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Ftools%2Fsurface.ts%23mustPresentString%5BParameter%5D%401|sha256=9cc09173c0b2ac912e976a719108a99edba5b38992ae8f6321106350273b99f4",
        identity: "src/tool-server/tools/surface.ts#mustPresentString[Parameter]@1",
        location: {
          file: "src/tool-server/tools/surface.ts",
          line: 542,
          column: 28,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Ftools%2Fsurface.ts%23normalizeAttachmentMeta%5BParameter%5D%401|sha256=31f6f741c9bb651c11710c9177ee6a5a29937125a34a73cf4ef821b57581573f",
        identity: "src/tool-server/tools/surface.ts#normalizeAttachmentMeta[Parameter]@1",
        location: {
          file: "src/tool-server/tools/surface.ts",
          line: 618,
          column: 34,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Ftools%2Fsurface.ts%23getDiscordReferenceFromRaw%5BParameter%5D%401|sha256=a4f18f36680d639160d42ea60aca1c00e367d8ff677e5af9fa50af7a9193fb5f",
        identity: "src/tool-server/tools/surface.ts#getDiscordReferenceFromRaw[Parameter]@1",
        location: {
          file: "src/tool-server/tools/surface.ts",
          line: 661,
          column: 37,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Ftools%2Fsurface.ts%23extractDiscordAttachmentMetaFromRaw%5BParameter%5D%401|sha256=465aea3e36e693c1207a47f423a3885711aa784475ad0f4c79d0ff43bb7e14c1",
        identity:
          "src/tool-server/tools/surface.ts#extractDiscordAttachmentMetaFromRaw[Parameter]@1",
        location: {
          file: "src/tool-server/tools/surface.ts",
          line: 676,
          column: 46,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Ftools%2Fsurface.ts%23getDiscordMessageTypeMetaFromRaw%5BParameter%5D%401|sha256=655467a0c2e892e2423ee081a003d8d870105d32f7a1ede6fe7af5418b3c64eb",
        identity: "src/tool-server/tools/surface.ts#getDiscordMessageTypeMetaFromRaw[Parameter]@1",
        location: {
          file: "src/tool-server/tools/surface.ts",
          line: 719,
          column: 43,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Ftools%2Fssh.ts%23readStreamText%5BParameter%5D%401|sha256=163779cc784501e66ce10f501370da0dc54a5183cead468ff3857dbdf234f31a",
        identity: "src/tool-server/tools/ssh.ts#readStreamText[Parameter]@1",
        location: {
          file: "src/tool-server/tools/ssh.ts",
          line: 74,
          column: 31,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fmcp%2Fregistry.ts%23safeErrorText%5BParameter%5D%401|sha256=6c0814f3bb3d16887e06322a01c199021705042e5597d24ce166e4153d2f240a",
        identity: "src/mcp/registry.ts#safeErrorText[Parameter]@1",
        location: {
          file: "src/mcp/registry.ts",
          line: 154,
          column: 24,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fmcp%2Fregistry.ts%23isOptionalHttpInboundSseError%5BParameter%5D%401|sha256=f24f56fdee6c85d00ea2415f76058920d5bec771ed3f6aed49288e108ffc4473",
        identity: "src/mcp/registry.ts#isOptionalHttpInboundSseError[Parameter]@1",
        location: {
          file: "src/mcp/registry.ts",
          line: 227,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fmcp%2Fregistry.ts%23McpRegistry.wrapToolExecution.execute.%3Ccallback%3E%5BParameter%5D%401|sha256=a4b1f4a04eaf9b5a6e1a8710157dd96627634b1f546b9d74ce1dc2f6ae070686",
        identity:
          "src/mcp/registry.ts#McpRegistry.wrapToolExecution.execute.<callback>[Parameter]@1",
        location: {
          file: "src/mcp/registry.ts",
          line: 750,
          column: 34,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fmcp%2Fregistry.ts%23McpRegistry.failureStatus%5BParameter%5D%401|sha256=e1b18497d3a3c74d7745987c32baa4c8728c200f7ebf80f7f27952b4713a84ca",
        identity: "src/mcp/registry.ts#McpRegistry.failureStatus[Parameter]@1",
        location: {
          file: "src/mcp/registry.ts",
          line: 790,
          column: 5,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fmcp%2Fregistry.ts%23McpRegistry.initializeCandidate.%3Ccallback%3E.onUncaughtError%5BParameter%5D%401|sha256=a29f9308eeff1daf21e6ad8af1c2fba7b928d4d2daefe4329644df0a793885a0",
        identity:
          "src/mcp/registry.ts#McpRegistry.initializeCandidate.<callback>.onUncaughtError[Parameter]@1",
        location: {
          file: "src/mcp/registry.ts",
          line: 580,
          column: 31,
        },
        reason:
          "Existing domain-bearing unknown SDK callback pending its later registry migration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fmcp%2Fregistry.ts%23McpRegistry.handleTerminalFailure%5BParameter%5D%401|sha256=77dc212014e715742ef2b2c70972c7e6bf6201c13f2ae6b3d43489247c7a85f7",
        identity: "src/mcp/registry.ts#McpRegistry.handleTerminalFailure[Parameter]@1",
        location: {
          file: "src/mcp/registry.ts",
          line: 849,
          column: 78,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fruntime%2Fprocess-handlers.ts%23%3Cmodule%3E%5BParameter%5D%401|sha256=3946413bff7bf186bbb16d717c5b8bb98cb45c78d2e3ba09a3ab5fb9b2d98196",
        identity: "src/runtime/process-handlers.ts#<module>[Parameter]@1",
        location: {
          file: "src/runtime/process-handlers.ts",
          line: 10,
          column: 31,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fruntime%2Fprocess-handlers.ts%23%3Cmodule%3E%5BParameter%5D%401|sha256=3820dae358ba0cc03f59d0f7f7c107f8e1670c17cb89ba1b2e33f84d7ae723b4",
        identity: "src/runtime/process-handlers.ts#<module>[Parameter]@1",
        location: {
          file: "src/runtime/process-handlers.ts",
          line: 19,
          column: 27,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fruntime%2Fprocess-handlers.ts%23%3Cmodule%3E%5BParameter%5D%402|sha256=38da4ef311f5f1ff5e7635a3c1907a8211c0fa4268aad1eb467425d863c6bb40",
        identity: "src/runtime/process-handlers.ts#<module>[Parameter]@2",
        location: {
          file: "src/runtime/process-handlers.ts",
          line: 20,
          column: 28,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fruntime%2Fprocess-handlers.ts%23createProcessHandlers.handleFatal%5BParameter%5D%401|sha256=a11a120f5bcafc4ad194e349a7b3333ff4dca05c1f30ac098b95db2cdec460e0",
        identity: "src/runtime/process-handlers.ts#createProcessHandlers.handleFatal[Parameter]@1",
        location: {
          file: "src/runtime/process-handlers.ts",
          line: 75,
          column: 47,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fruntime%2Fprocess-handlers.ts%23createProcessHandlers.handleUncaughtException%5BParameter%5D%401|sha256=22952353deb0b18a503e65d1bc95d53b55911ac0e7d5295143d4cc8826ac67b1",
        identity:
          "src/runtime/process-handlers.ts#createProcessHandlers.handleUncaughtException[Parameter]@1",
        location: {
          file: "src/runtime/process-handlers.ts",
          line: 104,
          column: 29,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fruntime%2Fprocess-handlers.ts%23createProcessHandlers.handleUnhandledRejection%5BParameter%5D%401|sha256=096b1a96405b2be7395d4e015d0bb47879d922dd46143892d803264c7d4dd8a8",
        identity:
          "src/runtime/process-handlers.ts#createProcessHandlers.handleUnhandledRejection[Parameter]@1",
        location: {
          file: "src/runtime/process-handlers.ts",
          line: 111,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Fhealth-state.ts%23previewReason%5BParameter%5D%401|sha256=3fdd1a279496fb66911f2dd5c7f89901191c834c550331200842c476bff8bdb9",
        identity: "src/tool-server/health-state.ts#previewReason[Parameter]@1",
        location: {
          file: "src/tool-server/health-state.ts",
          line: 144,
          column: 24,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Fhealth-state.ts%23createToolServerHealthState.recordUnhandledRejection%5BParameter%5D%401|sha256=2634b06b138fcfcfb941beb242e5cc30ab94370311dbedeb4c26407255836ba8",
        identity:
          "src/tool-server/health-state.ts#createToolServerHealthState.recordUnhandledRejection[Parameter]@1",
        location: {
          file: "src/tool-server/health-state.ts",
          line: 299,
          column: 37,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Fhealth-state.ts%23createToolServerHealthState.getSnapshot.%3Ccallback%3E%5BParameter%5D%401|sha256=97d77191879c37579e271adbaf25cc685b5f319bec2573c31132203e29f57b80",
        identity:
          "src/tool-server/health-state.ts#createToolServerHealthState.getSnapshot.<callback>[Parameter]@1",
        location: {
          file: "src/tool-server/health-state.ts",
          line: 410,
          column: 52,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Fcreate-tool-server.ts%23safeJsonPreview%5BParameter%5D%401|sha256=f256e6991de5481e9036bec5f85c757ad24fd5f9dfc3ebf7ad0c80933e61ecf1",
        identity: "src/tool-server/create-tool-server.ts#safeJsonPreview[Parameter]@1",
        location: {
          file: "src/tool-server/create-tool-server.ts",
          line: 52,
          column: 26,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Fcreate-tool-server.ts%23safeJsonPreview.replacer%5BParameter%5D%401|sha256=56705212ab5f1c55ff112000f552c0d700bfa961f376fcfb0c5952a240a7c370",
        identity: "src/tool-server/create-tool-server.ts#safeJsonPreview.replacer[Parameter]@1",
        location: {
          file: "src/tool-server/create-tool-server.ts",
          line: 73,
          column: 34,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Fcreate-tool-server.ts%23safeToolInputPreview%5BParameter%5D%401|sha256=6e1fb7159fea726cad5327d6c0005166386261252b901c8feef67f5e80d82500",
        identity: "src/tool-server/create-tool-server.ts#safeToolInputPreview[Parameter]@1",
        location: {
          file: "src/tool-server/create-tool-server.ts",
          line: 92,
          column: 51,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Fcreate-tool-server.ts%23headerStr%5BParameter%5D%401|sha256=9403589513c44bf331b28ccdde2eb8a4a451cea1e86d4e22e8ea61d6575a63cd",
        identity: "src/tool-server/create-tool-server.ts#headerStr[Parameter]@1",
        location: {
          file: "src/tool-server/create-tool-server.ts",
          line: 98,
          column: 20,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Fcreate-tool-server.ts%23estimateJsonBytes%5BParameter%5D%401|sha256=be8608ecfc24c4fef0294580a3d51a381fd668daa2541b9751df5fe399babb16",
        identity: "src/tool-server/create-tool-server.ts#estimateJsonBytes[Parameter]@1",
        location: {
          file: "src/tool-server/create-tool-server.ts",
          line: 191,
          column: 28,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Fcreate-tool-server.ts%23createToolServer.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%401|sha256=f0e89b15b157b9060ab148dbec68e2c8c76c355e8700410ce7a740d00ad202b5",
        identity:
          "src/tool-server/create-tool-server.ts#createToolServer.<callback>.<callback>[Parameter]@1",
        location: {
          file: "src/tool-server/create-tool-server.ts",
          line: 672,
          column: 14,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-server%2Fcreate-tool-server.ts%23createToolServer.recordUnhandledRejection%5BParameter%5D%401|sha256=eb0e762fd10296de023ffd7147a090aec41fcb4dae8645f7c23801aeea21ba57",
        identity:
          "src/tool-server/create-tool-server.ts#createToolServer.recordUnhandledRejection[Parameter]@1",
        location: {
          file: "src/tool-server/create-tool-server.ts",
          line: 845,
          column: 32,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fconversation%2Fthread-materializer.ts%23createThreadMaterializer%5BParameter%5D%401|sha256=34d15e6cab65dfad9f3d33da11073dc1e3ab8c862531156bbb7838ca2f27bb2f",
        identity: "src/conversation/thread-materializer.ts#createThreadMaterializer[Parameter]@1",
        location: {
          file: "src/conversation/thread-materializer.ts",
          line: 46,
          column: 14,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fconversation%2Fthread-materializer.ts%23createThreadMaterializer.reportError%5BParameter%5D%401|sha256=cbf49852b97573b13af3315efda766558f601a01f72ec89ee6485d098d0eb2d7",
        identity:
          "src/conversation/thread-materializer.ts#createThreadMaterializer.reportError[Parameter]@1",
        location: {
          file: "src/conversation/thread-materializer.ts",
          line: 57,
          column: 24,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fconversation%2Fthread-materializer.ts%23createThreadMaterializer.markAllDirty.%3Ccallback%3E%5BParameter%5D%401|sha256=0d9a207ae86cf8df99097e54af5bee6663c3209cfdde1809010976f28aa82bf3",
        identity:
          "src/conversation/thread-materializer.ts#createThreadMaterializer.markAllDirty.<callback>[Parameter]@1",
        location: {
          file: "src/conversation/thread-materializer.ts",
          line: 165,
          column: 17,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fconversation%2Fthread-materializer-worker.ts%23startConversationThreadMaterializer.onError%5BParameter%5D%401|sha256=62578d4666b4f3fae4b990361f17d6eca288a343695fdf068ce9a7c002739c8c",
        identity:
          "src/conversation/thread-materializer-worker.ts#startConversationThreadMaterializer.onError[Parameter]@1",
        location: {
          file: "src/conversation/thread-materializer-worker.ts",
          line: 160,
          column: 20,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fconversation%2Fthread-summarization-worker.ts%23isWorkerRequest%5BParameter%5D%401|sha256=d6e5413ef890cb9c19baa437fa03371c6de5cffe5ee2b1cfae756f180e49a3e5",
        identity: "src/conversation/thread-summarization-worker.ts#isWorkerRequest[Parameter]@1",
        location: {
          file: "src/conversation/thread-summarization-worker.ts",
          line: 21,
          column: 26,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fconversation%2Fthread-worker.ts%23isWorkerResponse%5BParameter%5D%401|sha256=451c63e8e868bdf3a7eca8400650bfb66afa48b2ba169013bd07b01ded358dbd",
        identity: "src/conversation/thread-worker.ts#isWorkerResponse[Parameter]@1",
        location: {
          file: "src/conversation/thread-worker.ts",
          line: 37,
          column: 27,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Frequest-composition%2Freply-chain.ts%23getForwardSnapshotTextFromRaw%5BParameter%5D%401|sha256=3152fec2834dcd6d3ed590d6a8ad303b82777f29c155e26da2e221ca152c2b83",
        identity:
          "src/surface/bridge/request-composition/reply-chain.ts#getForwardSnapshotTextFromRaw[Parameter]@1",
        location: {
          file: "src/surface/bridge/request-composition/reply-chain.ts",
          line: 25,
          column: 47,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Frequest-composition%2Freply-chain.ts%23extractDiscordAttachmentsFromRaw%5BParameter%5D%401|sha256=3148759216298dc4626553c09bf46e6be9770c1bfb8b6dca14c925aac7d5094c",
        identity:
          "src/surface/bridge/request-composition/reply-chain.ts#extractDiscordAttachmentsFromRaw[Parameter]@1",
        location: {
          file: "src/surface/bridge/request-composition/reply-chain.ts",
          line: 38,
          column: 43,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Frequest-composition%2Freply-chain.ts%23getReferenceFromRaw%5BParameter%5D%401|sha256=5fd125e9da5e02b8d5f94246827d13d922cad180b253ed94812e93496b76b600",
        identity:
          "src/surface/bridge/request-composition/reply-chain.ts#getReferenceFromRaw[Parameter]@1",
        location: {
          file: "src/surface/bridge/request-composition/reply-chain.ts",
          line: 45,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Frequest-composition%2Freply-chain.ts%23hasReplyTargetInRaw%5BParameter%5D%401|sha256=19edcc2cd228bd7b91a3888f8dcf4082cf03c1e904176d023b87a07d61d049e9",
        identity:
          "src/surface/bridge/request-composition/reply-chain.ts#hasReplyTargetInRaw[Parameter]@1",
        location: {
          file: "src/surface/bridge/request-composition/reply-chain.ts",
          line: 53,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Frequest-composition.ts%23getDiscordIsChatFromRaw%5BParameter%5D%401|sha256=caaefaf119c15d32d02ba6269670622d34b51d2deb990bd74202c9bcba7f14b1",
        identity: "src/surface/bridge/request-composition.ts#getDiscordIsChatFromRaw[Parameter]@1",
        location: {
          file: "src/surface/bridge/request-composition.ts",
          line: 615,
          column: 34,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-request-router.ts%23startBusRequestRouter.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%401|sha256=68e1aa35625f2dff861823f9536b4df9fcecd206d6c69a5b30cdccc3793edf00",
        identity:
          "src/surface/bridge/bus-request-router.ts#startBusRequestRouter.<callback>.<callback>[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-request-router.ts",
          line: 370,
          column: 19,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-request-router.ts%23startBusRequestRouter.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%402|sha256=c507ce5ea2f7e2ac78334155802ee2cebb7cd928ff83f88afb047842ffd770f3",
        identity:
          "src/surface/bridge/bus-request-router.ts#startBusRequestRouter.<callback>.<callback>[Parameter]@2",
        location: {
          file: "src/surface/bridge/bus-request-router.ts",
          line: 583,
          column: 19,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-request-router.ts%23startBusRequestRouter.bufferActiveChannelMessage.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%401|sha256=6352462a34d3e455ead0e68e9ecbefa3a9bd60a1db2f1a3cd77ac9483d741541",
        identity:
          "src/surface/bridge/bus-request-router.ts#startBusRequestRouter.bufferActiveChannelMessage.<callback>.<callback>[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-request-router.ts",
          line: 1467,
          column: 41,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-request-router.ts%23startBusRequestRouter.flushDebounce.%3Ccallback%3E%5BParameter%5D%401|sha256=6043585eb756592153b8501370afb525bbdc2dbede47b28de16e24c80ea9a6a9",
        identity:
          "src/surface/bridge/bus-request-router.ts#startBusRequestRouter.flushDebounce.<callback>[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-request-router.ts",
          line: 1499,
          column: 19,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fshared%2Fagent-output-activity.ts%23createAgentOutputActivityPublisher%5BParameter%5D%401|sha256=9511de4673d09d3027e5b8960349beece21bc896612c6520a508ded7e81238f1",
        identity:
          "src/shared/agent-output-activity.ts#createAgentOutputActivityPublisher[Parameter]@1",
        location: {
          file: "src/shared/agent-output-activity.ts",
          line: 8,
          column: 14,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fshared%2Fagent-output-activity.ts%23createAgentOutputActivityPublisher.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%401|sha256=31770c0394e5c38c7d4a553d2136cc3a396cd50b580620d7177d44e6659e2234",
        identity:
          "src/shared/agent-output-activity.ts#createAgentOutputActivityPublisher.<callback>.<callback>[Parameter]@1",
        location: {
          file: "src/shared/agent-output-activity.ts",
          line: 18,
          column: 40,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fworkflow-live-parent-bridge.ts%23WorkflowLiveParentBridge.enableOrphanHandling.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%401|sha256=5dad340be2b2d7df5e16e89d6f016b056bf8823cb108a74cada33435c6d97b4c",
        identity:
          "src/workflow/workflow-live-parent-bridge.ts#WorkflowLiveParentBridge.enableOrphanHandling.<callback>.<callback>[Parameter]@1",
        location: {
          file: "src/workflow/workflow-live-parent-bridge.ts",
          line: 187,
          column: 45,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fworkflow-live-parent-bridge.ts%23WorkflowLiveParentBridge.publishParentDisplay.%3Ccallback%3E%5BParameter%5D%401|sha256=404472cebb29b30e1710ed88917e9e58374cf78bcbc235565ce07b222a062377",
        identity:
          "src/workflow/workflow-live-parent-bridge.ts#WorkflowLiveParentBridge.publishParentDisplay.<callback>[Parameter]@1",
        location: {
          file: "src/workflow/workflow-live-parent-bridge.ts",
          line: 670,
          column: 49,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fworkflow-live-parent-bridge.ts%23WorkflowLiveParentBridge.stopChildActivity.%3Ccallback%3E.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%401|sha256=d1aa0ac4e397697348f56e4f33f0bcae7345e87beb3d75b201b1ff766a27246a",
        identity:
          "src/workflow/workflow-live-parent-bridge.ts#WorkflowLiveParentBridge.stopChildActivity.<callback>.<callback>.<callback>[Parameter]@1",
        location: {
          file: "src/workflow/workflow-live-parent-bridge.ts",
          line: 787,
          column: 44,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fworkflow-live-parent-bridge.ts%23WorkflowLiveParentBridge.reconcileOrphans.%3Ccallback%3E%5BParameter%5D%401|sha256=3879f7e312fb65a52bdcb8d91b63f2c69af7bfd9fc488e0dd5d044d24fb32998",
        identity:
          "src/workflow/workflow-live-parent-bridge.ts#WorkflowLiveParentBridge.reconcileOrphans.<callback>[Parameter]@1",
        location: {
          file: "src/workflow/workflow-live-parent-bridge.ts",
          line: 832,
          column: 16,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23%3Ccallback%3E%5BParameter%5D%402|sha256=923614619f9756f0e6bddc85cbb2e9927dd8901cd38144346397f0b4e380d8ea",
        identity: "src/surface/bridge/bus-agent-runner/raw.ts#<callback>[Parameter]@2",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 22,
          column: 4,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23%3Ccallback%3E%5BParameter%5D%403|sha256=262e9b3e419896c4ba8f7c6762eda7b9391adc7a70f3548808338fcf376c3b2e",
        identity: "src/surface/bridge/bus-agent-runner/raw.ts#<callback>[Parameter]@3",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 26,
          column: 4,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23%3Ccallback%3E%5BParameter%5D%404|sha256=9754e4ad3dbacb18b3ace3c5011532fee26055b2cc695950992d5ef540a77d99",
        identity: "src/surface/bridge/bus-agent-runner/raw.ts#<callback>[Parameter]@4",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 30,
          column: 4,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23%3Ccallback%3E%5BParameter%5D%405|sha256=4dd19a44a4054c27f6f6f42ef5ec965664792e387772e4bbbe23e7b4e84d47ca",
        identity: "src/surface/bridge/bus-agent-runner/raw.ts#<callback>[Parameter]@5",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 33,
          column: 41,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23%3Ccallback%3E%5BParameter%5D%406|sha256=a7409da69bd09b7fa413732a83db26828789c6a6700d473dd8c7b29a7ca3f1ae",
        identity: "src/surface/bridge/bus-agent-runner/raw.ts#<callback>[Parameter]@6",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 35,
          column: 4,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23%3Ccallback%3E%5BParameter%5D%407|sha256=fa3bf97fda5f52c389cd0af4fdadb72359aec6b48a1313cedb3ea441695d4546",
        identity: "src/surface/bridge/bus-agent-runner/raw.ts#<callback>[Parameter]@7",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 39,
          column: 4,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23%3Ccallback%3E%5BParameter%5D%408|sha256=fae2a9b3fbb73b2b29eb89aae727842c87a433463ae9b8ba9f35a5db45971ec4",
        identity: "src/surface/bridge/bus-agent-runner/raw.ts#<callback>[Parameter]@8",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 43,
          column: 4,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23isModelReasoningEffort%5BParameter%5D%401|sha256=25189fbf795c64708659d3814994418e77d65d07aa572146e5a330d58d10b4bf",
        identity: "src/surface/bridge/bus-agent-runner/raw.ts#isModelReasoningEffort[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 47,
          column: 33,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23%3Ccallback%3E%5BParameter%5D%409|sha256=caedc124a4a3dd06a4b432ccb4499f4725f359aee6d5f50bce44a6116956c6e1",
        identity: "src/surface/bridge/bus-agent-runner/raw.ts#<callback>[Parameter]@9",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 52,
          column: 4,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23parseWorkflowRequestHintFromRaw%5BParameter%5D%401|sha256=0a8178b7ae762cb0637014c0418c13108008f28f4b591726402727d4a0925c10",
        identity:
          "src/surface/bridge/bus-agent-runner/raw.ts#parseWorkflowRequestHintFromRaw[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 118,
          column: 49,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23parseRouterRaw%5BParameter%5D%401|sha256=400741e928b415dc4b6a12fb12dd45a0eb107e89752bb655f11a771fed3ac33f",
        identity: "src/surface/bridge/bus-agent-runner/raw.ts#parseRouterRaw[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 123,
          column: 25,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23parseRouterSessionModeFromRaw%5BParameter%5D%401|sha256=893f0ff086830bea6a6117a7a43b948b4b8170e90903d4dba2ecc3684d4e8c99",
        identity:
          "src/surface/bridge/bus-agent-runner/raw.ts#parseRouterSessionModeFromRaw[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 128,
          column: 47,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23parseSessionConfigIdFromRaw%5BParameter%5D%401|sha256=ad1ed97e084b1180d2fb18676bb2c38f1e18835b15b125a471519ce92281c836",
        identity:
          "src/surface/bridge/bus-agent-runner/raw.ts#parseSessionConfigIdFromRaw[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 132,
          column: 45,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23parseParentChannelIdFromRaw%5BParameter%5D%401|sha256=c696280ef5a53efc29f300772d5c088c397b36730499d1c8a27c704a9f0bee91",
        identity:
          "src/surface/bridge/bus-agent-runner/raw.ts#parseParentChannelIdFromRaw[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 136,
          column: 45,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23parseRequestModelOverrideFromRaw%5BParameter%5D%401|sha256=85c47ccff1242e8035e1220b0bd3267daf1af32d22227d9f9657e010b12adfe8",
        identity:
          "src/surface/bridge/bus-agent-runner/raw.ts#parseRequestModelOverrideFromRaw[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 140,
          column: 50,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23parseRequestControlFromRaw%5BParameter%5D%401|sha256=eca9bca0418701457e6920ab3bbe35e7c8b4357d9f1405007879bb92676173db",
        identity:
          "src/surface/bridge/bus-agent-runner/raw.ts#parseRequestControlFromRaw[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 151,
          column: 44,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23parseBufferedForActiveRequestIdFromRaw%5BParameter%5D%401|sha256=f7e928c1bcd66edd55e9f1492f5b420b2acf8eef893cd80fff66d23167ba3ea1",
        identity:
          "src/surface/bridge/bus-agent-runner/raw.ts#parseBufferedForActiveRequestIdFromRaw[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 171,
          column: 56,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23getChainMessageIdsFromRaw%5BParameter%5D%401|sha256=94caec33ba436bb1b293b2926aa0503ee4437bc0e7b34666bc07ad74a55b9929",
        identity:
          "src/surface/bridge/bus-agent-runner/raw.ts#getChainMessageIdsFromRaw[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 175,
          column: 43,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23getParticipantUserIdsFromRaw%5BParameter%5D%401|sha256=bfa4d22d7ac7bdcd82a591744db9c09282af08351c7482e0a598938d20002230",
        identity:
          "src/surface/bridge/bus-agent-runner/raw.ts#getParticipantUserIdsFromRaw[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 179,
          column: 46,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23requestRawReferencesMessage%5BParameter%5D%401|sha256=915258bf1b927d1a6895771c9df226ba9b4a195129510d659f72cbf3a5c532d7",
        identity:
          "src/surface/bridge/bus-agent-runner/raw.ts#requestRawReferencesMessage[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 185,
          column: 45,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23isSubagentProfile%5BParameter%5D%401|sha256=07296bd9910c8e5280226ab86eb15ea009934dcef0b721835d7d741dcd134276",
        identity: "src/surface/bridge/bus-agent-runner/raw.ts#isSubagentProfile[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 189,
          column: 28,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23parseSubagentMetaFromRaw%5BParameter%5D%401|sha256=3b859d5df4a8b2b5315df225fab141d5f827d1c2902dc0d95461d7240cddc5d2",
        identity:
          "src/surface/bridge/bus-agent-runner/raw.ts#parseSubagentMetaFromRaw[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 193,
          column: 42,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23parseCustomCommandFromRaw%5BParameter%5D%401|sha256=85e9d6a2a3b3cf1ce136d7c9bf065f129e6ab4b5169375206e6ed9e87368a266",
        identity:
          "src/surface/bridge/bus-agent-runner/raw.ts#parseCustomCommandFromRaw[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 224,
          column: 43,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fanthropic-fallback-media.ts%23readProviderOrder%5BParameter%5D%401|sha256=d90dd878b8ea13c6a5fc439bab2951104ef4474215dfea18192aa1083ad1f918",
        identity:
          "src/surface/bridge/bus-agent-runner/anthropic-fallback-media.ts#readProviderOrder[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/anthropic-fallback-media.ts",
          line: 57,
          column: 28,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fformatting.ts%23debugJsonStringify%5BParameter%5D%401|sha256=e7f3dacdb1a072344a062de917ef08d5c1c2c2d5aad5d4e6b2f845813ab3eaa5",
        identity:
          "src/surface/bridge/bus-agent-runner/formatting.ts#debugJsonStringify[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/formatting.ts",
          line: 24,
          column: 36,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fformatting.ts%23safeStringify%5BParameter%5D%401|sha256=9b6d916b0fe9eadc4b8ade76f082485de90bcf6a6d206e1ad0ef97866cd1cf26",
        identity: "src/surface/bridge/bus-agent-runner/formatting.ts#safeStringify[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/formatting.ts",
          line: 59,
          column: 31,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Ferror-display.ts%23readNonEmptyString%5BParameter%5D%401|sha256=530137f37405a80f1a4195c36d1eb6745b1759118e4f8fae7796ad7c39177771",
        identity:
          "src/surface/bridge/bus-agent-runner/error-display.ts#readNonEmptyString[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/error-display.ts",
          line: 5,
          column: 29,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Ferror-display.ts%23formatErrorLabel%5BParameter%5D%401|sha256=228602f2d01e90a4da072963b739d1150a81515860ca55e9d738848f6f45f8eb",
        identity:
          "src/surface/bridge/bus-agent-runner/error-display.ts#formatErrorLabel[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/error-display.ts",
          line: 9,
          column: 27,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Ferror-display.ts%23extractReadableErrorMessage%5BParameter%5D%401|sha256=1d83fae95abe7126e4b4a34175129a9238a369f45aee7cba2c3946ede6425162",
        identity:
          "src/surface/bridge/bus-agent-runner/error-display.ts#extractReadableErrorMessage[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/error-display.ts",
          line: 16,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Ferror-display.ts%23formatUnknownErrorForDisplay%5BParameter%5D%401|sha256=74277f8537debd2b8cc0832ed6502c9039baa36607a798b5dfd1fe00d5475ce6",
        identity:
          "src/surface/bridge/bus-agent-runner/error-display.ts#formatUnknownErrorForDisplay[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/error-display.ts",
          line: 62,
          column: 46,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Foutput-publisher.ts%23createAgentOutputPublisher%5BParameter%5D%401|sha256=87e6bc32778af525a2a1818aff1d602a0b783f0c2f5619d45dcdd2ea8877bc3b",
        identity:
          "src/surface/bridge/bus-agent-runner/output-publisher.ts#createAgentOutputPublisher[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/output-publisher.ts",
          line: 40,
          column: 29,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Foutput-publisher.ts%23createAgentOutputPublisher.enqueue.%3Ccallback%3E%5BParameter%5D%401|sha256=041824e3723e4483020081fc93ed26be7edf8898f1518c64fadec1337c97c099",
        identity:
          "src/surface/bridge/bus-agent-runner/output-publisher.ts#createAgentOutputPublisher.enqueue.<callback>[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/output-publisher.ts",
          line: 51,
          column: 42,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fstats.ts%23systemPromptToText%5BParameter%5D%401|sha256=4a2f65c7fffa6a98e61ab0e9b90254c3e135c4d2f6bfdb7987b5d88f1b302fc7",
        identity: "src/surface/bridge/bus-agent-runner/stats.ts#systemPromptToText[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/stats.ts",
          line: 225,
          column: 36,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fcore-named-continuation.ts%23semanticFingerprint%5BParameter%5D%401|sha256=3461325904ad7c1b4dad268bd121196fd7a5d50e50bb9bc7232e3e34f73e66bd",
        identity:
          "src/surface/bridge/bus-agent-runner/core-named-continuation.ts#semanticFingerprint[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/core-named-continuation.ts",
          line: 145,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23estimateTokensFromValue%5BParameter%5D%401|sha256=edf022bbb88526b1d9f82e98c09207c762340fd326720e9e45faf73447312287",
        identity: "src/surface/bridge/bus-agent-runner.ts#estimateTokensFromValue[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 447,
          column: 34,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23getBatchOkFromResult%5BParameter%5D%401|sha256=72f17cbde99d9e6a969ac3b663925349110b12a4e702fb79d83c37c41a72dfef",
        identity: "src/surface/bridge/bus-agent-runner.ts#getBatchOkFromResult[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 554,
          column: 31,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23getSubagentOkFromResult%5BParameter%5D%401|sha256=728f1f3773be5dfb8e1faa74283544b61e35eae1028a0d743258d2722dadec5c",
        identity: "src/surface/bridge/bus-agent-runner.ts#getSubagentOkFromResult[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 560,
          column: 34,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23isDeferredSubagentAcceptedResult%5BParameter%5D%401|sha256=47299b835fa94ead3e866af7a58b2d5ff9b30b8a57dff9d70328a0e5cefec361",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#isDeferredSubagentAcceptedResult[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 566,
          column: 43,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23maybeBuildAutoInjectedThreadSearchMessages%5BParameter%5D%401|sha256=f6f43bd28051f7e1719105f000a9de59fb6cafeee3dccb83c3c4690d7c624bdf",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#maybeBuildAutoInjectedThreadSearchMessages[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 919,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23startBusAgentRunner.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%401|sha256=2eb7a315f636051ca1eb913212c093388fbb7a9d024f05cc024c7a18ce400702",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#startBusAgentRunner.<callback>.<callback>[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 2295,
          column: 56,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23startBusAgentRunner.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%402|sha256=589a7d9fe05d2a5f12e6c238a6c29a20b43dd2d858802845210ef43b0e6d3ebf",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#startBusAgentRunner.<callback>.<callback>[Parameter]@2",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 2381,
          column: 52,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23startBusAgentRunner.restoreRecoverables.%3Ccallback%3E%5BParameter%5D%401|sha256=f9d90456a9cc2b34306c97e07123aa8517a1d877665d35cf4b04ef9d88c70a46",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#startBusAgentRunner.restoreRecoverables.<callback>[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 2748,
          column: 58,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23startBusAgentRunner.drainSessionQueue.onError%5BParameter%5D%401|sha256=3780ed3010a645b92397a780df48704ddf87fa88098672dd281971061ca68bdb",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#startBusAgentRunner.drainSessionQueue.onError[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 2830,
          column: 24,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23startBusAgentRunner.drainSessionQueue.onError%5BParameter%5D%402|sha256=241c9bd14e6774a3d2ad20a591cdfef4676f363a520781ccd158d656d870fb3e",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#startBusAgentRunner.drainSessionQueue.onError[Parameter]@2",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 2877,
          column: 17,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23startBusAgentRunner.drainSessionQueue.onTimeout.%3Ccallback%3E%5BParameter%5D%401|sha256=893946eed06db8172f3a46417a17b9e73439823c4753750bd826de2c283d398b",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#startBusAgentRunner.drainSessionQueue.onTimeout.<callback>[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 2902,
          column: 24,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23startBusAgentRunner.drainSessionQueue.buildModelBinding.reportToolStatus.%3Ccallback%3E%5BParameter%5D%401|sha256=101b3c6ed0486fc0ff650e5f657b56d1012b933dc7ef2f239c778e60ee2cde25",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#startBusAgentRunner.drainSessionQueue.buildModelBinding.reportToolStatus.<callback>[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 3661,
          column: 62,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23startBusAgentRunner.drainSessionQueue.turnErrorHandler%5BParameter%5D%401|sha256=1b917494c999d505e5772965b640950ead538b58d703eb14b0ac2b46e1bf88af",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#startBusAgentRunner.drainSessionQueue.turnErrorHandler[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 3782,
          column: 9,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23startBusAgentRunner.drainSessionQueue.onServerCompactionError%5BParameter%5D%401|sha256=31edc9d3444514951956fa00b6e0cc7ae37a7a033de9fdd40412afab6b9b7135",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#startBusAgentRunner.drainSessionQueue.onServerCompactionError[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 4257,
          column: 37,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23startBusAgentRunner.drainSessionQueue.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%401|sha256=6d241a3e28fd7b347e4ff7ad15aadcbb6a8c463d67186d52f68d1260f225df04",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#startBusAgentRunner.drainSessionQueue.<callback>.<callback>[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 4905,
          column: 23,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23startBusAgentRunner.drainSessionQueue.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%402|sha256=0f0250feb63837d3a7252f87f846e1302ee4cc60edff4a2114d06d956844e93e",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#startBusAgentRunner.drainSessionQueue.<callback>.<callback>[Parameter]@2",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 5008,
          column: 74,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23startBusAgentRunner.drainSessionQueue.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%403|sha256=a555afdb1168477e11ddc42f2cd98c78e9104005abc035d58c3ebe8341086399",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#startBusAgentRunner.drainSessionQueue.<callback>.<callback>[Parameter]@3",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 5030,
          column: 76,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23startBusAgentRunner.drainSessionQueue.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%404|sha256=f4c79a54e10f997b61794ff661722ca095dab5a908e4017796a4b0214943fa46",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#startBusAgentRunner.drainSessionQueue.<callback>.<callback>[Parameter]@4",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 5069,
          column: 23,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23startBusAgentRunner.drainSessionQueue.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%405|sha256=506f23fcbc31de9286680ad4257d4aca1eddea4fc6c4cc392162b8bb2c7bc3af",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#startBusAgentRunner.drainSessionQueue.<callback>.<callback>[Parameter]@5",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 5150,
          column: 21,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23startBusAgentRunner.drainSessionQueue.onError%5BParameter%5D%403|sha256=27bf7b1902645f2ac2b1b58ffe6a6d0bc2f0f13ce057f52c5797240a421215e0",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#startBusAgentRunner.drainSessionQueue.onError[Parameter]@3",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 5215,
          column: 38,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23startBusAgentRunner.drainSessionQueue.%3Ccallback%3E%5BParameter%5D%401|sha256=d9a95f4b5794ecc972639a1819ad23e6cbac8dc1b8d70f75810c808ada1ee09d",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#startBusAgentRunner.drainSessionQueue.<callback>[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 5775,
          column: 78,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23startBusAgentRunner.drainSessionQueue.%3Ccallback%3E%5BParameter%5D%401|sha256=72a51f39aa96b865b9a688dc525592ab2f4c16d9633ed5575de37358812a9bfc",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#startBusAgentRunner.drainSessionQueue.<callback>[Parameter]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 5849,
          column: 61,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23startBusAgentRunner.drainSessionQueue.%3Ccallback%3E%5BParameter%5D%402|sha256=51fea42dbd9764d7c15913819a8b64338b9ac6e958f90e3b7ba9a48721fae8e5",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#startBusAgentRunner.drainSessionQueue.<callback>[Parameter]@2",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 5856,
          column: 63,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23startBusAgentRunner.drainSessionQueue.%3Ccallback%3E%5BParameter%5D%403|sha256=c2c150cb2f4f4ff503d92bee080611c087f51d0c7b4ce686da3c0016637d2dcc",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#startBusAgentRunner.drainSessionQueue.<callback>[Parameter]@3",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 5863,
          column: 45,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23startBusAgentRunner.drainSessionQueue.%3Ccallback%3E%5BParameter%5D%404|sha256=123b6f6db23db79d7618522460cb294d7495b8f6891429211a2e5ea4cda11143",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#startBusAgentRunner.drainSessionQueue.<callback>[Parameter]@4",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 5877,
          column: 50,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fworkflow-sandbox.ts%23errorFrom%5BParameter%5D%401|sha256=fc7d98e0794bf1260c3280f86dad8534e25e31eedfd54cda665ca75f26fe51e9",
        identity: "src/workflow/workflow-sandbox.ts#errorFrom[Parameter]@1",
        location: {
          file: "src/workflow/workflow-sandbox.ts",
          line: 76,
          column: 20,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fworkflow-sandbox.ts%23startWorkflowSandbox.%3Ccallback%3E%5BParameter%5D%401|sha256=dbb6a54dd79470edba6504b472cb026890d5c09778040db75dfa7835a1d8b24f",
        identity: "src/workflow/workflow-sandbox.ts#startWorkflowSandbox.<callback>[Parameter]@1",
        location: {
          file: "src/workflow/workflow-sandbox.ts",
          line: 107,
          column: 6,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fworkflow-sandbox.ts%23startWorkflowSandbox%5BParameter%5D%401|sha256=44d003e5a43a4868b4cc232292078b645e523dfb0712c585ea1c22095e44452b",
        identity: "src/workflow/workflow-sandbox.ts#startWorkflowSandbox[Parameter]@1",
        location: {
          file: "src/workflow/workflow-sandbox.ts",
          line: 115,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fworkflow-sandbox.ts%23startWorkflowSandbox.terminate.%3Ccallback%3E%5BParameter%5D%401|sha256=17023c7e3464bcde5676e8c933a5d2a9bf8008b400cb0fbdb6af04c65bb843e3",
        identity:
          "src/workflow/workflow-sandbox.ts#startWorkflowSandbox.terminate.<callback>[Parameter]@1",
        location: {
          file: "src/workflow/workflow-sandbox.ts",
          line: 156,
          column: 8,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fworkflow-sandbox.ts%23startWorkflowSandbox.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%401|sha256=38668556192300dceede9b0dad5a81f54cf8cb0a19aef972638835e5f0365cfb",
        identity:
          "src/workflow/workflow-sandbox.ts#startWorkflowSandbox.<callback>.<callback>[Parameter]@1",
        location: {
          file: "src/workflow/workflow-sandbox.ts",
          line: 239,
          column: 18,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fworkflow-sandbox.ts%23startWorkflowSandbox.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%402|sha256=1cde39008fff0b2842c7911b28a1fb6cc4d894d8ece92dfe3ce9ad41c2004a8e",
        identity:
          "src/workflow/workflow-sandbox.ts#startWorkflowSandbox.<callback>.<callback>[Parameter]@2",
        location: {
          file: "src/workflow/workflow-sandbox.ts",
          line: 250,
          column: 23,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fworkflow-engine.ts%23boundedError%5BParameter%5D%401|sha256=8528d67ec3274af2d0104babaedbd0b0f1458f94047a8faae0db9430e65c26e5",
        identity: "src/workflow/workflow-engine.ts#boundedError[Parameter]@1",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 130,
          column: 23,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fworkflow-engine.ts%23WorkflowEngine.start.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%401|sha256=6e5c71cfea1e02f75514f2dce662b5f4a56aa0cb0c14936cf384f5725c8dfe7b",
        identity:
          "src/workflow/workflow-engine.ts#WorkflowEngine.start.<callback>.<callback>[Parameter]@1",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 224,
          column: 38,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fworkflow-engine.ts%23WorkflowEngine.claimAndLaunch.%3Ccallback%3E%5BParameter%5D%401|sha256=7dbf115feee4ed203efda6071c674371bf1d1e46374c08cfcc899f98c331de0a",
        identity:
          "src/workflow/workflow-engine.ts#WorkflowEngine.claimAndLaunch.<callback>[Parameter]@1",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 338,
          column: 15,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fworkflow-waits.ts%23replyToMessageId%5BParameter%5D%401|sha256=7c192a4aa4380b0e15354aeb4e4ee3d5310c8d89e63d129a169291eac6f2f678",
        identity: "src/workflow/workflow-waits.ts#replyToMessageId[Parameter]@1",
        location: {
          file: "src/workflow/workflow-waits.ts",
          line: 35,
          column: 27,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fworkflow-wait-resolver.ts%23WorkflowWaitResolver.observeSubscription.%3Ccallback%3E%5BParameter%5D%401|sha256=352a5a3449f839d2aa982f7964dbca713ad3263c7c9a1e7594dca4af30de7a42",
        identity:
          "src/workflow/workflow-wait-resolver.ts#WorkflowWaitResolver.observeSubscription.<callback>[Parameter]@1",
        location: {
          file: "src/workflow/workflow-wait-resolver.ts",
          line: 158,
          column: 10,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fworkflow-wait-resolver.ts%23WorkflowWaitResolver.observeSubscription.%3Ccallback%3E%5BParameter%5D%402|sha256=11ca2a270a3c811dc2ef2e8d32c6910ccd6528c16440073047564bf8cbb4e2ba",
        identity:
          "src/workflow/workflow-wait-resolver.ts#WorkflowWaitResolver.observeSubscription.<callback>[Parameter]@2",
        location: {
          file: "src/workflow/workflow-wait-resolver.ts",
          line: 160,
          column: 15,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fworkflow-wait-resolver.ts%23WorkflowWaitResolver.handleSubscriptionTermination%5BParameter%5D%401|sha256=b9db69243bcdcbcc385a638ff05bbe11e7eaa74585e81ce9c1edd7b460923190",
        identity:
          "src/workflow/workflow-wait-resolver.ts#WorkflowWaitResolver.handleSubscriptionTermination[Parameter]@1",
        location: {
          file: "src/workflow/workflow-wait-resolver.ts",
          line: 165,
          column: 72,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fworkflow-wait-resolver.ts%23WorkflowWaitResolver.handleSubscriptionTermination.%3Ccallback%3E%5BParameter%5D%401|sha256=3f55a79eaed20841c620f6d0016b4aef122f67795caf67dccbac822d83fa7a7c",
        identity:
          "src/workflow/workflow-wait-resolver.ts#WorkflowWaitResolver.handleSubscriptionTermination.<callback>[Parameter]@1",
        location: {
          file: "src/workflow/workflow-wait-resolver.ts",
          line: 175,
          column: 15,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkflow%2Fworkflow-trigger-scheduler.ts%23WorkflowTriggerScheduler.fire.%3Ccallback%3E%5BParameter%5D%401|sha256=1ddaa3a93413aee45e420c06c9103dbdfa85a59fbd2c027b874b9e49de8fea84",
        identity:
          "src/workflow/workflow-trigger-scheduler.ts#WorkflowTriggerScheduler.fire.<callback>[Parameter]@1",
        location: {
          file: "src/workflow/workflow-trigger-scheduler.ts",
          line: 129,
          column: 80,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fruntime%2Fcreate-core-runtime.ts%23%3Cmodule%3E%5BParameter%5D%401|sha256=481e257135aa2d511e89f6d5dec3764b5b6000394e1c222e2f47d905a2887a28",
        identity: "src/runtime/create-core-runtime.ts#<module>[Parameter]@1",
        location: {
          file: "src/runtime/create-core-runtime.ts",
          line: 112,
          column: 28,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fruntime%2Fcreate-core-runtime.ts%23startCoreMcpServices.%3Ccallback%3E%5BParameter%5D%401|sha256=63a2b90cf01137280a188ac02857be2b81871a07e9a64c5d47db00ea402611c8",
        identity: "src/runtime/create-core-runtime.ts#startCoreMcpServices.<callback>[Parameter]@1",
        location: {
          file: "src/runtime/create-core-runtime.ts",
          line: 164,
          column: 13,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fruntime%2Fcreate-core-runtime.ts%23createCoreRuntime%5BParameter%5D%401|sha256=db3b299a5166d6f009b5c873ebb63a5d45d6abc2b4eaeaa67d8d59cc65acd7f2",
        identity: "src/runtime/create-core-runtime.ts#createCoreRuntime[Parameter]@1",
        location: {
          file: "src/runtime/create-core-runtime.ts",
          line: 343,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fruntime%2Fcreate-core-runtime.ts%23createCoreRuntime.startCoreConfigWatcher.%3Ccallback%3E%5BParameter%5D%401|sha256=42315a5cda9d8f2180ae929b07c51c8b6a744aa41e2d5f80c026460855ec0631",
        identity:
          "src/runtime/create-core-runtime.ts#createCoreRuntime.startCoreConfigWatcher.<callback>[Parameter]@1",
        location: {
          file: "src/runtime/create-core-runtime.ts",
          line: 547,
          column: 38,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fruntime%2Fcreate-core-runtime.ts%23createCoreRuntime.start.%3Ccallback%3E%5BParameter%5D%401|sha256=4a8c8dc83d0b3bd375e13b7f0c6f5141009c880744e9467dc0c8fc2b179f1701",
        identity:
          "src/runtime/create-core-runtime.ts#createCoreRuntime.start.<callback>[Parameter]@1",
        location: {
          file: "src/runtime/create-core-runtime.ts",
          line: 1082,
          column: 68,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fruntime%2Fcreate-core-runtime.ts%23createCoreRuntime.recordUnhandledRejection%5BParameter%5D%401|sha256=5694bbaebc4647d894a3c3b2ec974d5eb303d652a4852425b9a8b7c532f6c133",
        identity:
          "src/runtime/create-core-runtime.ts#createCoreRuntime.recordUnhandledRejection[Parameter]@1",
        location: {
          file: "src/runtime/create-core-runtime.ts",
          line: 1385,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fruntime%2Fmain.ts%23recordUnhandledRejection%5BParameter%5D%401|sha256=60d96e58e34a9bdf7b0da1607d55694c477ddd55fa31c24fffd2b9a19352d1d6",
        identity: "src/runtime/main.ts#recordUnhandledRejection[Parameter]@1",
        location: {
          file: "src/runtime/main.ts",
          line: 16,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fruntime%2Fmain.ts%23%3Ccallback%3E%5BParameter%5D%401|sha256=25ae1aa56d70ba7cbb1833b57942f7f00ef1985270004bc8d0985add21f619cf",
        identity: "src/runtime/main.ts#<callback>[Parameter]@1",
        location: {
          file: "src/runtime/main.ts",
          line: 21,
          column: 35,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fssh%2Fremote-js%2Fremote-runner-entry.ts%23ok%5BParameter%5D%401|sha256=a3a09fbd11905b4d806a173325f73f39ca282e25e4b8d701eec9a4d2d3760617",
        identity: "src/ssh/remote-js/remote-runner-entry.ts#ok[Parameter]@1",
        location: {
          file: "src/ssh/remote-js/remote-runner-entry.ts",
          line: 16,
          column: 13,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fssh%2Fremote-js%2Fremote-runner-entry.ts%23fail%5BParameter%5D%401|sha256=cf0c623538ae96cecdc79baf897e157fc3e16b872cd8e937e43cbbd496330c24",
        identity: "src/ssh/remote-js/remote-runner-entry.ts#fail[Parameter]@1",
        location: {
          file: "src/ssh/remote-js/remote-runner-entry.ts",
          line: 20,
          column: 15,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fssh%2Fremote-js%2Fremote-runner-entry.ts%23numberOrUndefined%5BParameter%5D%401|sha256=bcb308849be585fa53c29f0ac24e560e4f80b61a05e9927e626ada13e311aa63",
        identity: "src/ssh/remote-js/remote-runner-entry.ts#numberOrUndefined[Parameter]@1",
        location: {
          file: "src/ssh/remote-js/remote-runner-entry.ts",
          line: 54,
          column: 28,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Fssh%2Fremote-js%2Fremote-runner-entry.ts%23ordinaryFileStartOrUndefined%5BParameter%5D%401|sha256=b24e9b85cc6f9a714769f840676a3402b5d1c5ba2d4fef6c58669fd61d3f24f3",
        identity:
          "src/ssh/remote-js/remote-runner-entry.ts#ordinaryFileStartOrUndefined[Parameter]@1",
        location: {
          file: "src/ssh/remote-js/remote-runner-entry.ts",
          line: 59,
          column: 39,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Fattachment.ts%23normalizeAttachmentAddFilesInput%5BParameter%5D%401|sha256=7f2757d0a53b527178a07056a29c7a1cfd581408657335b542b6811498bb5e70",
        identity: "src/tools/attachment.ts#normalizeAttachmentAddFilesInput[Parameter]@1",
        location: {
          file: "src/tools/attachment.ts",
          line: 41,
          column: 43,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Fattachment.ts%23asBuffer%5BParameter%5D%401|sha256=e3dfe029040c764eaa8170f3bb77ddeb4cf15f4666e1b64dc35ba1645508f5bc",
        identity: "src/tools/attachment.ts#asBuffer[Parameter]@1",
        location: {
          file: "src/tools/attachment.ts",
          line: 55,
          column: 19,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-domain-unknown|identity=src%2Ftools%2Fattachment.ts%23downloadToBuffer%5BParameter%5D%401|sha256=ebe95fe01211f34d3d10c26cbe78a66740add71fa43a706946f8aa1a6a7ced7d",
        identity: "src/tools/attachment.ts#downloadToBuffer[Parameter]@1",
        location: {
          file: "src/tools/attachment.ts",
          line: 193,
          column: 33,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
    ],
    "architecture/no-rich-unknown-predicate": [
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-rich-unknown-predicate|identity=src%2Fsurface%2Fdiscord%2Fdiscord-channel-guards.ts%23isTextSendableChannel%5BFunctionDeclaration%5D%401|sha256=a614c4b499f085464aef7511859ced37af8db9696ba3b10aee2676c88c272630",
        identity:
          "src/surface/discord/discord-channel-guards.ts#isTextSendableChannel[FunctionDeclaration]@1",
        location: {
          file: "src/surface/discord/discord-channel-guards.ts",
          line: 33,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-rich-unknown-predicate|identity=src%2Fsurface%2Fbridge%2Fbus-request-router%2Fcommon.ts%23isConfigRecord%5BFunctionDeclaration%5D%401|sha256=f5f3c42c5929cc55e0fe81708c6e203f4c3f67b3c15792278b87ee56575f7a1e",
        identity:
          "src/surface/bridge/bus-request-router/common.ts#isConfigRecord[FunctionDeclaration]@1",
        location: {
          file: "src/surface/bridge/bus-request-router/common.ts",
          line: 397,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-rich-unknown-predicate|identity=src%2Fconversation%2Fthread-embedding.ts%23hasEmbeddingModel%5BFunctionDeclaration%5D%401|sha256=b692b9642d008bed6e2987f07f015fea66fd42b37712f34359657b7e10a94098",
        identity: "src/conversation/thread-embedding.ts#hasEmbeddingModel[FunctionDeclaration]@1",
        location: {
          file: "src/conversation/thread-embedding.ts",
          line: 59,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-rich-unknown-predicate|identity=src%2Fssh%2Fssh-exec.ts%23isResponseBodyInit%5BFunctionDeclaration%5D%401|sha256=5452ab8c05949c3d69878e73e8465f9d57d4b2d08c0b9a1eae64cfe175efbe31",
        identity: "src/ssh/ssh-exec.ts#isResponseBodyInit[FunctionDeclaration]@1",
        location: {
          file: "src/ssh/ssh-exec.ts",
          line: 41,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-rich-unknown-predicate|identity=src%2Ftools%2Fbash-output-sanitizer.ts%23isResponseBodyInit%5BFunctionDeclaration%5D%401|sha256=40ff3a9f3798c504d4d68a10342bfdc49c891757e611312b760622a0f3260da8",
        identity: "src/tools/bash-output-sanitizer.ts#isResponseBodyInit[FunctionDeclaration]@1",
        location: {
          file: "src/tools/bash-output-sanitizer.ts",
          line: 314,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-rich-unknown-predicate|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Ftool-failure-logging.ts%23isRecord%5BFunctionDeclaration%5D%401|sha256=7265d61022f986a7d283f1bba23284f9d2397c6ca089d865e583ad8ba757d7fd",
        identity:
          "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts#isRecord[FunctionDeclaration]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/tool-failure-logging.ts",
          line: 27,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-rich-unknown-predicate|identity=src%2Ftools%2Ftool-args-display.ts%23isZodSchema%5BFunctionDeclaration%5D%401|sha256=ffff6a97ff3efa41d575b07709c917473acf43a481b51f4b485c560aee91a2be",
        identity: "src/tools/tool-args-display.ts#isZodSchema[FunctionDeclaration]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 12,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-rich-unknown-predicate|identity=src%2Ftools%2Ftool-args-display.ts%23isPromiseLike%5BFunctionDeclaration%5D%401|sha256=9bcff7cdb3c117136c454affaab7eecb0d6194acff5a90d50e522a01479361a8",
        identity: "src/tools/tool-args-display.ts#isPromiseLike[FunctionDeclaration]@1",
        location: {
          file: "src/tools/tool-args-display.ts",
          line: 23,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-rich-unknown-predicate|identity=src%2Fconversation%2Fthread-summarization-worker.ts%23isWorkerRequest%5BFunctionDeclaration%5D%401|sha256=8a14b79ca63fd1728ea86a61ebbcad412dc6e40226be3c99cabd85ee1606f96b",
        identity:
          "src/conversation/thread-summarization-worker.ts#isWorkerRequest[FunctionDeclaration]@1",
        location: {
          file: "src/conversation/thread-summarization-worker.ts",
          line: 21,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-rich-unknown-predicate|identity=src%2Fconversation%2Fthread-worker.ts%23isWorkerResponse%5BFunctionDeclaration%5D%401|sha256=80d024cd6236991afd191ad00067dc0217e5b9aeb978b266da794638cabed30d",
        identity: "src/conversation/thread-worker.ts#isWorkerResponse[FunctionDeclaration]@1",
        location: {
          file: "src/conversation/thread-worker.ts",
          line: 37,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-rich-unknown-predicate|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23isDeferredSubagentAcceptedResult%5BFunctionDeclaration%5D%401|sha256=c8ed47c8e8a425f384779fda2bc221ec365cf0ef8882386f832713cacd1f338d",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#isDeferredSubagentAcceptedResult[FunctionDeclaration]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 566,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
    ],
    "architecture/no-unregistered-decoder": [
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsurface%2Fdiscord%2Fdiscord-adapter.ts%23discordNotFoundCode%5BCallExpression%5D%401|sha256=50606dd09121018c7497f9cb27ecd763587a5226f7412eb4bc234d5e57727b49",
        identity: "src/surface/discord/discord-adapter.ts#discordNotFoundCode[CallExpression]@1",
        location: {
          file: "src/surface/discord/discord-adapter.ts",
          line: 78,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsurface%2Fdiscord%2Fdiscord-adapter.ts%23DiscordAdapter.fetchDiscordMessage.%3Ccallback%3E%5BCallExpression%5D%401|sha256=74f521a519e8d5f0bdf85e00eb960a77b1a749044dc83e591b0c9c74ebd68dc1",
        identity:
          "src/surface/discord/discord-adapter.ts#DiscordAdapter.fetchDiscordMessage.<callback>[CallExpression]@1",
        location: {
          file: "src/surface/discord/discord-adapter.ts",
          line: 2151,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsurface%2Fdiscord%2Fdiscord-adapter.ts%23DiscordAdapter.fetchDiscordMessage.%3Ccallback%3E%5BCallExpression%5D%402|sha256=39fa95cc3b5d5975a117e67ee3ccd035b14c722a6c05f56d545fe534adf587c4",
        identity:
          "src/surface/discord/discord-adapter.ts#DiscordAdapter.fetchDiscordMessage.<callback>[CallExpression]@2",
        location: {
          file: "src/surface/discord/discord-adapter.ts",
          line: 2157,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23computeCorePrimaryClaudeTerminalHead%5BCallExpression%5D%401|sha256=4545ddbdaf3d82830d27c2033a86140e3f09d86b70344da3ec5afcc1137a17ff",
        identity:
          "src/transcript/transcript-store.ts#computeCorePrimaryClaudeTerminalHead[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 562,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23computeCorePrimaryClaudeTerminalHead%5BCallExpression%5D%401|sha256=5b34fdeabfa80061a52ada04f2a03bf9cb61aec062c23e9eb9b29b3c8869ec28",
        identity:
          "src/transcript/transcript-store.ts#computeCorePrimaryClaudeTerminalHead[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 565,
          column: 32,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23computeCorePrimaryClaudeTerminalHead%5BCallExpression%5D%401|sha256=a39f105735f7256d9142589ea9968dc401b4aa67d9da154cd3ee7ee8cc26a609",
        identity:
          "src/transcript/transcript-store.ts#computeCorePrimaryClaudeTerminalHead[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 568,
          column: 16,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23computeCorePrimaryClaudeTerminalHead%5BCallExpression%5D%401|sha256=5ffa309122064eccf738482a46832d13faa41e3c45dc4472f39e7a3b3e299fc3",
        identity:
          "src/transcript/transcript-store.ts#computeCorePrimaryClaudeTerminalHead[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 569,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.migrate.%3Ccallback%3E%5BCallExpression%5D%401|sha256=ccb07f074190646ceb7bda295a2cd85b45aa52b1ef1d3b4149e1b09b0372a4b4",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.migrate.<callback>[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 858,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.migrate.%3Ccallback%3E%5BCallExpression%5D%401|sha256=2a0a130300c2607e7dc2346ab313bc5295842171f55a708c1b96ef0f3bc832f7",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.migrate.<callback>[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1252,
          column: 34,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.saveRequestTranscript%5BCallExpression%5D%401|sha256=4676cdf8da5887f595fbcf0545d12e63fbd00ab04bd96dd516c204106f696c6d",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.saveRequestTranscript[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1331,
          column: 9,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.saveRequestTranscript%5BCallExpression%5D%401|sha256=ced886ee6afcd8df8bf4f72b1c6e4592f8465d7c088c2fe89900abdda37fd481",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.saveRequestTranscript[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1334,
          column: 9,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.putCoreOwnedBlob%5BCallExpression%5D%401|sha256=d534ec1a77aff012cf8e8c64f6e1015b90c6256479a5d69197b0a1b64b11b42e",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.putCoreOwnedBlob[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1423,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getCoreOwnedBlob%5BCallExpression%5D%401|sha256=dfe32c325fc0298504e9cf2a3e0725090b6f796e39ea2b361996f6b2c3bb59db",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getCoreOwnedBlob[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1447,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.deleteCoreOwnedBlobIfUnreferenced%5BCallExpression%5D%401|sha256=b92393af081172e69403b4f770d37e7bad8eff962af00fe4b272edca470cecef",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.deleteCoreOwnedBlobIfUnreferenced[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1454,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.admitCoreSurfaceProjection%5BCallExpression%5D%401|sha256=b5fd0f5f07b572b01994417b4d9930865bc68303eff495ae1751668d212119ed",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.admitCoreSurfaceProjection[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1474,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getCoreSurfaceProjection%5BCallExpression%5D%401|sha256=3525f350f2b8576009dc0eb3e0911e8f92f062042c7c6accedd2f03fc944f151",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getCoreSurfaceProjection[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1540,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getCoreSurfaceProjection%5BCallExpression%5D%401|sha256=4a916b964fa98027aad63efd24c99462a6ad42aea5944db5c45899fd961aa886",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getCoreSurfaceProjection[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1571,
          column: 36,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getCoreSurfaceProjection%5BCallExpression%5D%401|sha256=79e238df9c09ee02e26d914a4bf71fb206a3ddb1ed4710a2ae3ce84eff646273",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getCoreSurfaceProjection[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1593,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getCoreSurfaceProjection%5BCallExpression%5D%401|sha256=291f35641818a184012d21b7e1e13cd86b1d9a16ccf2cfbcc0a6f396eea62c07",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getCoreSurfaceProjection[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1597,
          column: 32,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getCoreSurfaceProjection%5BCallExpression%5D%401|sha256=533d589c1e7d1ae6da7542729ebbb3eba0fbf1c03e87cf82f38ea33146bfbb80",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getCoreSurfaceProjection[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1598,
          column: 26,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getCoreSurfaceProjection%5BCallExpression%5D%401|sha256=3e46c9f8edf07302c08ad4a3f4d550b900ea847839f48731123e028b5b0b022b",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getCoreSurfaceProjection[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1601,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getCoreSurfaceProjection%5BCallExpression%5D%401|sha256=a1e66031fae93f00bd166907cb358c7cfb856b040ccc2a59df87f2b40955426a",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getCoreSurfaceProjection[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1605,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getLatestCoreSurfaceSegment%5BCallExpression%5D%401|sha256=4dbc325240f036d994ced7d8ec69daf2a0ea7fe456d15a3ca925223ee8e40928",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getLatestCoreSurfaceSegment[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1612,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.saveCorePrimaryLineageManifest%5BCallExpression%5D%401|sha256=67e0e088a05b3280ad8310f3b873d239377dd982f2019b9e91e173bd1c45d953",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.saveCorePrimaryLineageManifest[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1651,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getCorePrimaryLineageManifest%5BCallExpression%5D%401|sha256=d0365d120f4fd31b0f42282c7fff609ba82850d4927f1a196ef7aaeef154d544",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getCorePrimaryLineageManifest[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1662,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.saveCorePrimaryLineageManifestInTransaction%5BCallExpression%5D%401|sha256=27decd7995800f39127c3a936d4f1a5248e3c7789648a265e9683c546d83e727",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.saveCorePrimaryLineageManifestInTransaction[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1695,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.validateCorePrimaryLineageReferences%5BCallExpression%5D%401|sha256=36ee389e85bed7335e16f3736b85047765308989513d00ab1bcb402ba65fa765",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.validateCorePrimaryLineageReferences[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1792,
          column: 28,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.validateCorePrimaryLineageReferences%5BCallExpression%5D%401|sha256=c8bc7c12bdb5fa15592faeba1568902b6caa4d371aca1775bad334a7441f532f",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.validateCorePrimaryLineageReferences[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1824,
          column: 34,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.validateCorePrimaryLineageReferences%5BCallExpression%5D%401|sha256=1712f9474bf820b4954fb30865d2250cc724ce1adbb3b4901514def6f39f4bfd",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.validateCorePrimaryLineageReferences[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1844,
          column: 30,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.validateCorePrimaryLineageReferences%5BCallExpression%5D%402|sha256=e5562fda1c708d432638e0b6aa03e6d4ec461070a0e0021b68b75e67a79a8369",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.validateCorePrimaryLineageReferences[CallExpression]@2",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1880,
          column: 28,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.parseCompleteCorePrimaryLineage%5BCallExpression%5D%401|sha256=5ae8766f6b89e8896f5bede0b2103c823b7b3f68c359e51070f673fc957c7ef9",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.parseCompleteCorePrimaryLineage[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 1900,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getLatestCompleteNamedTranscript%5BCallExpression%5D%401|sha256=186c787a725f55aff63d6b4449b49fd372f6b0874041bd3a38b6da412b0405c0",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getLatestCompleteNamedTranscript[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2072,
          column: 25,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getCoreNamedClaudeSessionBinding%5BCallExpression%5D%401|sha256=d68c2582f2343db870c15c34d0714130ab4af6dc0d7645a398a232fac69d3bb7",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getCoreNamedClaudeSessionBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2091,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getCoreNamedClaudeSessionAttempt%5BCallExpression%5D%401|sha256=6f1e15f15f7749d4a88cc077f8e2f26ee12075f1ab1320a66d542a243000bd38",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getCoreNamedClaudeSessionAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2112,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.reserveCoreNamedClaudeSessionAttempt%5BCallExpression%5D%401|sha256=13d7f71e418c1e7f469fa0332d49eb0bd890f1eddbabd6c338a51da55e8cdf35",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.reserveCoreNamedClaudeSessionAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2134,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.reserveCoreNamedClaudeSessionAttempt.%3Ccallback%3E%5BCallExpression%5D%401|sha256=050ccc9d59edb103d96d95fea75c0347906db3984100175eaf1503b236364a52",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.reserveCoreNamedClaudeSessionAttempt.<callback>[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2154,
          column: 27,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.recordCoreNamedClaudeSessionAttemptOutcome%5BCallExpression%5D%401|sha256=92dc5cad95c6cc7fdade5de9d0f678cdf3e0446581ddce30f09d8394bdcb9dfd",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.recordCoreNamedClaudeSessionAttemptOutcome[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2208,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.publishCoreNamedClaudeSuccess%5BCallExpression%5D%401|sha256=1700641d9f179e4f4ff285306992ffd64c74c20b7f05405f2496d6564a654abe",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.publishCoreNamedClaudeSuccess[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2250,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.promoteCoreNamedClaudeSessionBinding%5BCallExpression%5D%401|sha256=941cee4806e64eebd75a236ac6d6e53bb1594a80869c0d6e6fa2c7377001f7bf",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.promoteCoreNamedClaudeSessionBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2351,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getCorePrimaryClaudeSessionBinding%5BCallExpression%5D%401|sha256=92160015b12f195251f97b6cce7845779300504fbbeba431132362af174e7915",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getCorePrimaryClaudeSessionBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2363,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getCoreRetentionDiagnostics.count%5BCallExpression%5D%401|sha256=64f2ed7eeddb1eacbe9ecec57ab07c71f0ca038af9062638c873f216ddbf2ef9",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getCoreRetentionDiagnostics.count[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2415,
          column: 7,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getCoreRetentionDiagnostics%5BCallExpression%5D%401|sha256=381971d510bffa4cb83b84a466f27b01118c7cd93ed632cff1b1e8dbc91ce1a5",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getCoreRetentionDiagnostics[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2416,
          column: 25,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.getCorePrimaryClaudeSessionAttempt%5BCallExpression%5D%401|sha256=e691ee4ef49a864768969f41dd58c38c575d3b95e5ac0bfd8ae7eaea71aed17a",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.getCorePrimaryClaudeSessionAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2508,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.reserveCorePrimaryClaudeSessionAttempt%5BCallExpression%5D%401|sha256=667ff38be228bc931771b3fc6c4ec2b159c4e712aa9cf3a6def6765a6076b111",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.reserveCorePrimaryClaudeSessionAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2530,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.reserveCorePrimaryClaudeSessionAttempt.%3Ccallback%3E%5BCallExpression%5D%401|sha256=e87c3e67c5730125a3636c95e0e0592a9bebde80ede6a0d1014e34798826a70d",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.reserveCorePrimaryClaudeSessionAttempt.<callback>[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2551,
          column: 27,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.recordCorePrimaryClaudeSessionAttemptOutcome%5BCallExpression%5D%401|sha256=c7fe0fe1ddb239816de33174c7d5399e573c6f2c3bd4fc0afda4cb4cc77bd4ee",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.recordCorePrimaryClaudeSessionAttemptOutcome[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2606,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.publishCorePrimaryClaudeSuccess%5BCallExpression%5D%401|sha256=decb9228ec675dc9cb03f687e0954f6bda468903e7f604ee4937a991ba41951d",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.publishCorePrimaryClaudeSuccess[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2649,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.promoteCorePrimaryClaudeSessionBinding%5BCallExpression%5D%401|sha256=781aee1867fb3e56be1d8eb31fcae37a415710ae3bbc5e7eb5a0d4669caf5b62",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.promoteCorePrimaryClaudeSessionBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 2760,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.recoverCoreNamedClaudeAttempts%5BCallExpression%5D%401|sha256=58b735d6a337f031d1eaadcdb57cdeed90e0842bc317bf7a48bd595d1a37505d",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.recoverCoreNamedClaudeAttempts[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3201,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.findCorePrimaryTerminalRequestId%5BCallExpression%5D%401|sha256=ec51babe095e274935762a83ebc5b7aa6f13b745c58025626fedee904d2ce713",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.findCorePrimaryTerminalRequestId[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3321,
          column: 26,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.findCorePrimaryTerminalRequestId%5BCallExpression%5D%401|sha256=c6fb911f767521a032e159ffb045fe89e4aceb77cba4a53d557ebc8119493f72",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.findCorePrimaryTerminalRequestId[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3324,
          column: 35,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.findCorePrimaryTerminalRequestId%5BCallExpression%5D%401|sha256=c23757111fa5bdbc6f456e5b576a6fede5b7cc15080a304938e3acaaa4a62e0d",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.findCorePrimaryTerminalRequestId[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3325,
          column: 30,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.findCorePrimaryTerminalRequestId%5BCallExpression%5D%401|sha256=316585cb208783572db8b85e8fd69a6550d32035e9021ab93c95f09e681bf254",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.findCorePrimaryTerminalRequestId[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3326,
          column: 33,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.findCorePrimaryTerminalRequestId%5BCallExpression%5D%401|sha256=ea8d498ec05b8ba17802f27df1311a0eb6a48159c5572294df7d0036c5a3e785",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.findCorePrimaryTerminalRequestId[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3327,
          column: 42,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.recoverCorePrimaryClaudeAttempts%5BCallExpression%5D%401|sha256=d222a9c9b3b923fe423a323538f6d001d8056728967dc69c87fb5f499fde01fe",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.recoverCorePrimaryClaudeAttempts[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3620,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.rowToSnapshot%5BCallExpression%5D%401|sha256=dcdc02f20919df40ebc7fd70210769c4ae062df900e85ab517c1d8495ebe62cc",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.rowToSnapshot[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3668,
          column: 30,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.rowToSnapshot%5BCallExpression%5D%401|sha256=bb0c94a1874471ac0d0f4bd65570de05e2f762d1123c9f7a5630cd9f1020e8f5",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.rowToSnapshot[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3675,
          column: 27,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23SqliteTranscriptStore.rowToSnapshot%5BCallExpression%5D%401|sha256=669d1a046d79aa99c5ab33a9e92df91a655b56620739e7c70cee9d288cd341bb",
        identity:
          "src/transcript/transcript-store.ts#SqliteTranscriptStore.rowToSnapshot[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3677,
          column: 38,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23parseNormalizedCanonicalMessages%5BCallExpression%5D%401|sha256=c3fd392c6e5d327486f56b418b9326401d93542d3f7196fdf150fad65548120d",
        identity:
          "src/transcript/transcript-store.ts#parseNormalizedCanonicalMessages[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3803,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23parseNormalizedCanonicalMessages%5BCallExpression%5D%401|sha256=b89afb7464cc78ca181210e98140c859669c7b31cf5740246a4d26fc7c492e01",
        identity:
          "src/transcript/transcript-store.ts#parseNormalizedCanonicalMessages[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3804,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23validateCoreOwnedBlobRow%5BCallExpression%5D%401|sha256=5ced5f00d3bb4672160eb38b7b05cdb9cb8e82dd81893a886e970251c9fcda0b",
        identity: "src/transcript/transcript-store.ts#validateCoreOwnedBlobRow[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3808,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23validateCoreOwnedBlobRow%5BCallExpression%5D%401|sha256=46be8ad81e41e805d7931590db839045fe7db850e7ba44a3fafa646600e1f4fa",
        identity: "src/transcript/transcript-store.ts#validateCoreOwnedBlobRow[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3814,
          column: 17,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23validateCoreOwnedBlobRow%5BCallExpression%5D%401|sha256=f45aa90d732967f9f44c478f13fecb0c338b46428e76b0e9b0f7c970d813b150",
        identity: "src/transcript/transcript-store.ts#validateCoreOwnedBlobRow[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3829,
          column: 16,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23parseCompactionContextMeta%5BCallExpression%5D%401|sha256=c3920b226476010f953c5a74a49621c15ae5e73de327dba757a92f675141c56d",
        identity: "src/transcript/transcript-store.ts#parseCompactionContextMeta[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3847,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23parseHistoryProviderState%5BCallExpression%5D%401|sha256=d2efc1791554436af5a3c58f7505be02076f757801f9b4090eb6c060f08d572c",
        identity: "src/transcript/transcript-store.ts#parseHistoryProviderState[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3857,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeBinding%5BCallExpression%5D%401|sha256=4154a115173ea83324f9e2c00a62b6d2d0b146aedf5458e04e637cfadcd47b8c",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3866,
          column: 29,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeBinding%5BCallExpression%5D%401|sha256=4d513ca0d7b1197387feaca85055d5cd851f28e1db80ad7338b8d8f4ce491e68",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3868,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeBinding%5BCallExpression%5D%401|sha256=ff27f167b8a5708bc0fb968a74ad45bc40c46b3d726ec36d2dd6f34e8dd47fe6",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3869,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeBinding%5BCallExpression%5D%401|sha256=12a6b23e7470c01f6343794aae725b845debee8f1d3d15d4901b7c5ae1b7e8cb",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3872,
          column: 27,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeBinding%5BCallExpression%5D%401|sha256=4fc6cdb8a2b0fa372e67528efc7a61a87a90925ba3ac9f709cf1dc964b190853",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3874,
          column: 28,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeBinding%5BCallExpression%5D%401|sha256=d13a6bcda3e4d106fa5d81d02f15b95f52935eefea9d8c5222a98074c8cf4a06",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3875,
          column: 32,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeBinding%5BCallExpression%5D%401|sha256=a1e97a4128d03d62125ca385603f18cb5b5dc32b627f23ff20f8fdefc095834f",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3877,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeBinding%5BCallExpression%5D%401|sha256=8f37dc09ab9655a6b92cb5fd0f2715254ed57753b95a699b3fc9c7edaf739d7d",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3879,
          column: 25,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeBinding%5BCallExpression%5D%401|sha256=0c497450daa1cabbd3e8242857f53d015dd9fd2cd79c8f6d81253f0f0e63842e",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3880,
          column: 26,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeBinding%5BCallExpression%5D%401|sha256=a21e791249654ae84a6a91f6b8660100fc8095d1ec7bf0e7c95874c5f355bc91",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3881,
          column: 29,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeBinding%5BCallExpression%5D%401|sha256=67a169574ab9d2916de8b27e7f7b4f6869e00d4ea1d966f353de57ba09847980",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3884,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeBinding%5BCallExpression%5D%401|sha256=1e06707461fe2d5785afa8b772ef6534c60795815bc284ce11c6ee9bedf3e16d",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3885,
          column: 16,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeAttempt%5BCallExpression%5D%401|sha256=2bbe6f2aff66cd683d0d14fcf39cd0aa1b0e7496a8cb8d69c9f4bd2b768466cd",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3891,
          column: 14,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeAttempt%5BCallExpression%5D%401|sha256=e38527bb4273ef3de339ead9ae1267b85791e1dd98a1b189bf60503eabe3c258",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3893,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeAttempt%5BCallExpression%5D%401|sha256=a7d21f446f9fe62a8620d0f6c97afbceb6b7564541afbd3cdc5276d0ed540928",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3900,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeAttempt%5BCallExpression%5D%401|sha256=e567c7817f70964390b9692f5a3695a8cd120d8835566ef6fa579edb1235641f",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3901,
          column: 32,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeAttempt%5BCallExpression%5D%401|sha256=c171ef255f8178938330895de89736204abe325d12a7dc1c63e763ddceda6030",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3904,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeAttempt%5BCallExpression%5D%401|sha256=a97c34835064de5cc9652ef30d7d07381dfcb072540ca8caa2a931118be559b2",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3905,
          column: 25,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeAttempt%5BCallExpression%5D%401|sha256=bb1c1428dac6e12aa2623ab80c2eb861cfffaab7a7a83c2bc509f24fd8a4ab60",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3906,
          column: 62,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeAttempt%5BCallExpression%5D%401|sha256=275f2cc6a48b4db91e6f880c02cc54180c4c6310a58d35ddbb5f08f0be548151",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3910,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeAttempt%5BCallExpression%5D%401|sha256=3c78d35e6b2f10171a38246fa0661c907a573538622f0d3a300f612dd36f0d57",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3911,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeAttempt%5BCallExpression%5D%401|sha256=5520fa3894777abb64e58364f509cffa0efef73ae1630ba1840e62fdb5b45eb1",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3917,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeAttempt%5BCallExpression%5D%401|sha256=5e918cc5118cd3abe2485b920a6fd4e03bcf152c93b5e2043421748947f74091",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3922,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeAttempt%5BCallExpression%5D%401|sha256=b0bfb1e39c1aca65f5aae7bfdec8f0b9cbff999e85aa68f85a07a65b1780022b",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3926,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeAttempt%5BCallExpression%5D%401|sha256=40f4882607b5d644c1f0ef4e8280577e65e9f8183532e8c7c8aa9782c820b07a",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3930,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeAttempt%5BCallExpression%5D%401|sha256=4a12640a56ea0ad5973cc3e0085152835fa212cf3d6ea581281cc722400c2fce",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3933,
          column: 16,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCoreNamedClaudeAttempt%5BCallExpression%5D%401|sha256=02adc78719c128eb9031315c27b00437518a8386bc41f4ad37484e976eb46569",
        identity: "src/transcript/transcript-store.ts#toCoreNamedClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3934,
          column: 16,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeBinding%5BCallExpression%5D%401|sha256=9483a92f7c8cc2227758be6b592496de384e7f686a2f64a8e16ecc1bb4174de7",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3942,
          column: 29,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeBinding%5BCallExpression%5D%401|sha256=d333631940a49538bbfad75391dcb7834092a083ef95b12ca6e6cb04d8aa2cf9",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3944,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeBinding%5BCallExpression%5D%401|sha256=036bb08c97a4018db01663e4c1f7d6c6488edcf832354c63bbeb6a50694d19d3",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3945,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeBinding%5BCallExpression%5D%401|sha256=6d544c97a0bc1123c781e43f388e75b66e9c354db06a6724b33728dccbadf156",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3947,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeBinding%5BCallExpression%5D%401|sha256=738a4cf5010a5997f8a396ef9f27453842f6f5cd2a58469632f3c5f54c3b5d1d",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3948,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeBinding%5BCallExpression%5D%401|sha256=ea0cdb41fe45c1218a5e682e940b6f5c674968a35723338363c3019147d0bdd8",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3949,
          column: 16,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeBinding%5BCallExpression%5D%401|sha256=44930334f67de2893d347e841d580cec6159c260798fd5c4205aaa38a0535769",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3950,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeBinding%5BCallExpression%5D%401|sha256=e24a2bc5ca773a9881b18bee179a7d081fcdfed9a33b281da94f92cf9a81326f",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3951,
          column: 28,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeBinding%5BCallExpression%5D%401|sha256=91643763d7f3a255e4cf60f28535d0c3443b03df0dcea7ac54cb6823f1f6b814",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3952,
          column: 32,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeBinding%5BCallExpression%5D%401|sha256=2620a4e338b5b05f22d09e3d328b54ced3535fc57c6d97b7eaeb250148beeea6",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3954,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeBinding%5BCallExpression%5D%401|sha256=5db674cacea1f932467daffdf62dab7db45da9dca8a2e260ee718c1ddf6e2f38",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3956,
          column: 25,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeBinding%5BCallExpression%5D%401|sha256=30fe5bb5142f4526c20bed4cc54a97e8c781bdedc6b9e427c8ea209c3c5719f6",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3957,
          column: 26,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeBinding%5BCallExpression%5D%401|sha256=576f56f663075f0964da0809e0c038bdfd0f05fddf524c83ecfe69cefea118d9",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3958,
          column: 29,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeBinding%5BCallExpression%5D%401|sha256=fc4d00557601b3eca70e64920d60bf8a96d9aaef70e3617ea2ba6a06f8c51059",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3961,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeBinding%5BCallExpression%5D%401|sha256=faa75ca11bdbf4a01b1a64da8d251f1b986afb6b57e9f1fd682da76b225bf0bd",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeBinding[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3962,
          column: 16,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeAttempt%5BCallExpression%5D%401|sha256=033b22aeef61f69a0629682334cf185a3a744d8d779acbef9a8db1ca579d56f1",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3970,
          column: 14,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeAttempt%5BCallExpression%5D%401|sha256=3a8b218d07abe46080bd0a2af5d39815b0632b207cb89c1010220d1345a5d6dc",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3972,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeAttempt%5BCallExpression%5D%401|sha256=4b87bc4d23b7c01d065851aef9ad6df6e64a7b19dccf8362ab876cb9b8872206",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3975,
          column: 52,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeAttempt%5BCallExpression%5D%401|sha256=1be76b415267e60362a355b2e1c1bedc43002972028c920c802b6b3f764df8dd",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3977,
          column: 47,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeAttempt%5BCallExpression%5D%401|sha256=0c438db130a81c90338555578f8008b86768e0f8f473660d2ff7c40defc321ec",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3979,
          column: 50,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeAttempt%5BCallExpression%5D%401|sha256=55e67ccd173a469af93ca65db95c7565348826fa54167cc642aec8e30ee88a03",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3983,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeAttempt%5BCallExpression%5D%401|sha256=a8213b48d165fae01fbd78a5effd219d1a03437a528b181d9801f6a80becefc5",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3984,
          column: 32,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeAttempt%5BCallExpression%5D%401|sha256=970d3eae411d31dff39d9433311c97cb042e3cd419f5319270a4ccc6d94eda2f",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3987,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeAttempt%5BCallExpression%5D%401|sha256=12e40713ba6be80779d54aaf07302ed3589821e5657a30122299b5f2f69dd4fd",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3988,
          column: 25,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeAttempt%5BCallExpression%5D%401|sha256=5c546d0db6ac81bf1a0ef90a35924e377f6830d461ffe23c4e4a33aefcf9c4b4",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3989,
          column: 62,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeAttempt%5BCallExpression%5D%401|sha256=a99d7994f3f41d32e4322265d05ab3a46aebde70864541e5842d733d8e53cf21",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3993,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeAttempt%5BCallExpression%5D%401|sha256=14b805a2dfe7e58f86dc413cb0a3b5cc3ad50489ad224ef7a9cb19aa5847117f",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3994,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeAttempt%5BCallExpression%5D%401|sha256=7a95210bc4d9f697b9c8934be108a880a447daeb1e0f5589b8622750cc5718af",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 3999,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeAttempt%5BCallExpression%5D%401|sha256=88dd606afa74c9354893a14fcde5a6c038af0249ee3770c5213c82dcc43e2864",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 4003,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeAttempt%5BCallExpression%5D%401|sha256=4c81bf9007eb0cb9c7344db73bc0deb6e856ca833d83e9b7a3c61da119a3308c",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 4007,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeAttempt%5BCallExpression%5D%401|sha256=5bcf9e073cd4286740eae47a30802bf914630da328858597b6e592e80d00307a",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 4011,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeAttempt%5BCallExpression%5D%401|sha256=b4bf9e17204baf7339ffc125c20f3b671be38067c26338b66fad2195abfa5c88",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 4016,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeAttempt%5BCallExpression%5D%401|sha256=a31693338f59bfd3b44518d04c0c14528439e3153fbd979fb7c5b126fdabf003",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 4020,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeAttempt%5BCallExpression%5D%401|sha256=a821108da95c8aaff2fd9699188832be92f79baf35af1d93cc8834772ab02e15",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 4024,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeAttempt%5BCallExpression%5D%401|sha256=d6de1ae93abd77045a38191ffccf5b90f7e5d6fce16a068f24d0f817bdaa4d12",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 4027,
          column: 16,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftranscript%2Ftranscript-store.ts%23toCorePrimaryClaudeAttempt%5BCallExpression%5D%401|sha256=2f8dd750581ac5060472fe546434a5ab289e165896869cdba974f2523f3b991c",
        identity: "src/transcript/transcript-store.ts#toCorePrimaryClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/transcript/transcript-store.ts",
          line: 4028,
          column: 16,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fgithub%2Fgithub-app.ts%23readGithubAppSecret%5BCallExpression%5D%401|sha256=880f5bb79720850aa55f5b6de61ef5f37f33fbbab85cda15d3eed1913893702b",
        identity: "src/github/github-app.ts#readGithubAppSecret[CallExpression]@1",
        location: {
          file: "src/github/github-app.ts",
          line: 57,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fgithub%2Fgithub-user-token.ts%23readGithubUserTokenSecret%5BCallExpression%5D%401|sha256=02ba9980641cecbf3b77bba42d6d5de3f08f72df1ab5682df88efb64fb930c32",
        identity: "src/github/github-user-token.ts#readGithubUserTokenSecret[CallExpression]@1",
        location: {
          file: "src/github/github-user-token.ts",
          line: 44,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fgithub%2Fgithub-user-token.ts%23writeGithubUserTokenSecret%5BCallExpression%5D%401|sha256=4a14643f79e2ed5dde9c0bbde93da0b6ed3b2264f9dcc311ef13ddb6a040878d",
        identity: "src/github/github-user-token.ts#writeGithubUserTokenSecret[CallExpression]@1",
        location: {
          file: "src/github/github-user-token.ts",
          line: 58,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fgithub%2Fgithub-auth.ts%23fetchViewerLoginFromGithub%5BCallExpression%5D%401|sha256=1ca193c41c6ab85926bca6399efe2108742edfe5e3a419d139c5f6f893882d1e",
        identity: "src/github/github-auth.ts#fetchViewerLoginFromGithub[CallExpression]@1",
        location: {
          file: "src/github/github-auth.ts",
          line: 47,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsurface%2Fdiscord%2Fdiscord-raw-normalizer.ts%23parseRecord%5BCallExpression%5D%401|sha256=92abb7376ff95ad37c388f3a4b99ed6b3d34d0dd5ca3ad06fe18932767bb745d",
        identity: "src/surface/discord/discord-raw-normalizer.ts#parseRecord[CallExpression]@1",
        location: {
          file: "src/surface/discord/discord-raw-normalizer.ts",
          line: 89,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsurface%2Fdiscord%2Fdiscord-raw-normalizer.ts%23normalizeDiscordAttachment%5BCallExpression%5D%401|sha256=4a4c54d50b5655141f4f3ef54daa8938193486055aaa4c25e3fadded0c11ea85",
        identity:
          "src/surface/discord/discord-raw-normalizer.ts#normalizeDiscordAttachment[CallExpression]@1",
        location: {
          file: "src/surface/discord/discord-raw-normalizer.ts",
          line: 94,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsurface%2Fdiscord%2Fdiscord-raw-normalizer.ts%23normalizeDiscordRaw%5BCallExpression%5D%401|sha256=16100e8bbf8f839d9cce77cdb7cc382872631768a14dcf20af93adb6ff241f19",
        identity:
          "src/surface/discord/discord-raw-normalizer.ts#normalizeDiscordRaw[CallExpression]@1",
        location: {
          file: "src/surface/discord/discord-raw-normalizer.ts",
          line: 145,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsurface%2Fdiscord%2Fdiscord-raw-normalizer.ts%23normalizeDiscordRaw%5BCallExpression%5D%401|sha256=d0d44cea704f2760f06af979fffa04164a41bf9687799ac212cf3b79a4c25105",
        identity:
          "src/surface/discord/discord-raw-normalizer.ts#normalizeDiscordRaw[CallExpression]@1",
        location: {
          file: "src/surface/discord/discord-raw-normalizer.ts",
          line: 149,
          column: 25,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsurface%2Fdiscord%2Fdiscord-raw-normalizer.ts%23normalizeDiscordRaw%5BCallExpression%5D%401|sha256=808ffdb1d9fa0773bc68b09e2f27fd21720b90c40aa6e716205f37b7ba5fc228",
        identity:
          "src/surface/discord/discord-raw-normalizer.ts#normalizeDiscordRaw[CallExpression]@1",
        location: {
          file: "src/surface/discord/discord-raw-normalizer.ts",
          line: 151,
          column: 27,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fconversation%2Fthread-service.ts%23parseSummaryJson%5BCallExpression%5D%401|sha256=108614b9a943c4e6d7daa05f7de5e5b68cbc789ee1711162d7953a39b37c4c62",
        identity: "src/conversation/thread-service.ts#parseSummaryJson[CallExpression]@1",
        location: {
          file: "src/conversation/thread-service.ts",
          line: 837,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fconversation%2Fthread-service.ts%23parseQueryAboutnessJson%5BCallExpression%5D%401|sha256=c5aaa726366a7ff1f2895f8a2d1aaf7c1314348d43e162e9a2073dad4feff59a",
        identity: "src/conversation/thread-service.ts#parseQueryAboutnessJson[CallExpression]@1",
        location: {
          file: "src/conversation/thread-service.ts",
          line: 850,
          column: 36,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fconversation%2Fthread-service.ts%23parseAutoInjectQueryPlanJson%5BCallExpression%5D%401|sha256=7f1be52f7ff601b1fdf73dfdce5a65055b754667aece46dde323b6dcb2c7add4",
        identity:
          "src/conversation/thread-service.ts#parseAutoInjectQueryPlanJson[CallExpression]@1",
        location: {
          file: "src/conversation/thread-service.ts",
          line: 863,
          column: 41,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-domain.ts%23normalizeWorkflowResourcePolicy%5BCallExpression%5D%401|sha256=7c31a23634fbea76ec8660fb8f8e02de2411ab1b0987082aaed13a336443c3ac",
        identity:
          "src/workflow/workflow-domain.ts#normalizeWorkflowResourcePolicy[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-domain.ts",
          line: 101,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-domain.ts%23normalizeWorkflowResourcePolicy%5BCallExpression%5D%401|sha256=e64fb975b7f7ec45de8391f34e79ddeccd71e39c6b4d4702bb0d89e461b1e590",
        identity:
          "src/workflow/workflow-domain.ts#normalizeWorkflowResourcePolicy[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-domain.ts",
          line: 102,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-request-authority.ts%23workflowRequestPolicyIdentityProjection%5BCallExpression%5D%401|sha256=4e113b52b9bead82adf2fcacfa9f7492c608e2efe85585775ecc6a4453d87da2",
        identity:
          "src/workflow/workflow-request-authority.ts#workflowRequestPolicyIdentityProjection[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-request-authority.ts",
          line: 78,
          column: 27,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-operation-policy.ts%23resolveWorkflowAgentOperationInput%5BCallExpression%5D%401|sha256=3e597ec37a4c8869bd451cd036a45e6e39b1f14059f1eb17471bb876e73b8484",
        identity:
          "src/workflow/workflow-operation-policy.ts#resolveWorkflowAgentOperationInput[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-operation-policy.ts",
          line: 67,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-operation-policy.ts%23resolveWorkflowAgentOperationInput%5BCallExpression%5D%401|sha256=ba232ba4bf839fafe0be6c84c85f1cb18fa4db3c23d11476133595f2fcb3c53e",
        identity:
          "src/workflow/workflow-operation-policy.ts#resolveWorkflowAgentOperationInput[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-operation-policy.ts",
          line: 69,
          column: 7,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-operation-policy.ts%23resolveWorkflowAgentOperationInput%5BCallExpression%5D%401|sha256=ca29818c1a477309652765d835107457c92a846d96e217ae0f44aadb00d3c17c",
        identity:
          "src/workflow/workflow-operation-policy.ts#resolveWorkflowAgentOperationInput[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-operation-policy.ts",
          line: 79,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-operation-policy.ts%23resolveWorkflowAgentOperationInput%5BCallExpression%5D%401|sha256=d0893d3aa2a9a4469292a0c3d321e4942a33d9caca3d849aa4b4d4b53a9a01c3",
        identity:
          "src/workflow/workflow-operation-policy.ts#resolveWorkflowAgentOperationInput[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-operation-policy.ts",
          line: 84,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-definition.ts%23%3Ccallback%3E%5BCallExpression%5D%401|sha256=c83cc9c45e419359a837592f16f9143d026e18b808b2194a9c3dd37b6d3121d7",
        identity: "src/workflow/workflow-definition.ts#<callback>[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-definition.ts",
          line: 174,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-definition.ts%23assertStaticHostCallArguments.assertStaticObject%5BCallExpression%5D%401|sha256=17c07253e2e33e9379ddcbbba39014a694f52925cc827dbf7c17f8379b9ff5d2",
        identity:
          "src/workflow/workflow-definition.ts#assertStaticHostCallArguments.assertStaticObject[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-definition.ts",
          line: 744,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-definition.ts%23extractStaticMetadata%5BCallExpression%5D%401|sha256=196954a4ab59a203e0973d486104da32a0d9f46a95a03fc0253646edd9aedc6e",
        identity: "src/workflow/workflow-definition.ts#extractStaticMetadata[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-definition.ts",
          line: 950,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-definition.ts%23validateWorkflowArgs%5BCallExpression%5D%401|sha256=bc7b9359b82244e34a36d95a23d99d0de9e5dc56630aea1557dd704b014a7d83",
        identity: "src/workflow/workflow-definition.ts#validateWorkflowArgs[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-definition.ts",
          line: 1184,
          column: 16,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-definition.ts%23validateWorkflowArgs%5BCallExpression%5D%401|sha256=0d3b30122938c9748659457d78361c1b9e69d223efc1e7bdce32842f5bd50fd2",
        identity: "src/workflow/workflow-definition.ts#validateWorkflowArgs[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-definition.ts",
          line: 1192,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-definition.ts%23validateWorkflowArgs%5BCallExpression%5D%401|sha256=c78218d55fe5d5a93919534543917d9ceb5b7acbdca6ae97e1aaee70d59a8719",
        identity: "src/workflow/workflow-definition.ts#validateWorkflowArgs[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-definition.ts",
          line: 1193,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-definition.ts%23validateWorkflowSource%5BCallExpression%5D%401|sha256=6e1d249030fab9a8ea8fe1f1bc407ab722f89e3be37099ea28fb64ce2b420084",
        identity: "src/workflow/workflow-definition.ts#validateWorkflowSource[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-definition.ts",
          line: 1202,
          column: 16,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-definition.ts%23validateWorkflowSource%5BCallExpression%5D%401|sha256=6846784bc0bd6d6ae515041cdf6bd1b2759e68ba01c100b44e6cfe023ebcdd82",
        identity: "src/workflow/workflow-definition.ts#validateWorkflowSource[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-definition.ts",
          line: 1209,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-definition.ts%23validateWorkflowSource%5BCallExpression%5D%401|sha256=c2ac07f22512fabd3b481f9d67a3690066c938ba23423a111009e6c4ce184e36",
        identity: "src/workflow/workflow-definition.ts#validateWorkflowSource[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-definition.ts",
          line: 1212,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-definition.ts%23validateWorkflowSource%5BCallExpression%5D%401|sha256=8fd3de7fe804bb8e09041b8ddd9aec4e86cf3dd29e14db2c415bdb6eaf219e11",
        identity: "src/workflow/workflow-definition.ts#validateWorkflowSource[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-definition.ts",
          line: 1217,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-definition.ts%23validateWorkflowSource%5BCallExpression%5D%401|sha256=bbeb223965305b05c1b690024ce0c4963477cb297f15efc4bf63a1b84906e3d1",
        identity: "src/workflow/workflow-definition.ts#validateWorkflowSource[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-definition.ts",
          line: 1218,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-definition.ts%23validateWorkflowSource%5BCallExpression%5D%401|sha256=8f9d3e635c3498d06a8c77bf398fc62225a6cf99914cbbcb3677b219f9020762",
        identity: "src/workflow/workflow-definition.ts#validateWorkflowSource[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-definition.ts",
          line: 1230,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-definition.ts%23validateWorkflowSource%5BCallExpression%5D%401|sha256=8378bba5931718bd6dac26d7c2923c870a29edc0fb2bcff37b406088bc6bc3c8",
        identity: "src/workflow/workflow-definition.ts#validateWorkflowSource[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-definition.ts",
          line: 1246,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-definition.ts%23validateWorkflowSource%5BCallExpression%5D%401|sha256=a5584f519de9a6f1988c80f86bcdecd06e9b9e116a111058dfc314c6899dfea3",
        identity: "src/workflow/workflow-definition.ts#validateWorkflowSource[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-definition.ts",
          line: 1253,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-definition.ts%23validateWorkflowSource%5BCallExpression%5D%401|sha256=c05ce01fde660e15c0912983692292d26a3cc7174c21082e4cc9eb46b9ae1fd0",
        identity: "src/workflow/workflow-definition.ts#validateWorkflowSource[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-definition.ts",
          line: 1255,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-definition.ts%23validateWorkflowSource%5BCallExpression%5D%401|sha256=83635635ef9af3b89e7af389a3775481280870de6a24f454ceedcdd653d609e0",
        identity: "src/workflow/workflow-definition.ts#validateWorkflowSource[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-definition.ts",
          line: 1263,
          column: 52,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseRevision%5BCallExpression%5D%401|sha256=6b83296301078c9b889a453fbef9cdaaa4d61ac89a8f403159e18cccd5e3deef",
        identity: "src/workflow/durable-workflow-store.ts#parseRevision[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 256,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseRevision%5BCallExpression%5D%401|sha256=928e0cc92a75000e8f072947346a61b75e9ed7e861d3a7948e3f904f87e12f25",
        identity: "src/workflow/durable-workflow-store.ts#parseRevision[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 257,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseRun%5BCallExpression%5D%401|sha256=5c775978b182214b04344dad73a3f1f0b66fd711b5f3958bc1bc658027c71329",
        identity: "src/workflow/durable-workflow-store.ts#parseRun[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 278,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseRun%5BCallExpression%5D%401|sha256=50ccf1e6a18da33870f7519f2e52ed4ef10657cebec796e2617931ed1fff276f",
        identity: "src/workflow/durable-workflow-store.ts#parseRun[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 279,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseOperation%5BCallExpression%5D%401|sha256=fbe9d4e9e740c731fa4bf007292af566ed39932a8deb0086069f09ed3758bf28",
        identity: "src/workflow/durable-workflow-store.ts#parseOperation[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 311,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseOperation%5BCallExpression%5D%401|sha256=9ff12d7252462456474c5dfa85e49cd250639084ff5c4cee2dc3f31a821f5308",
        identity: "src/workflow/durable-workflow-store.ts#parseOperation[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 312,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseWait%5BCallExpression%5D%401|sha256=698e6d73aa00f260650f7e77583768c159fd926cbffc7e710f756b348c145450",
        identity: "src/workflow/durable-workflow-store.ts#parseWait[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 339,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseWait%5BCallExpression%5D%401|sha256=2c1e18360c2ab5057a45a8a700235e252cf13623c094cf4cdc42115a211699be",
        identity: "src/workflow/durable-workflow-store.ts#parseWait[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 340,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseTrigger%5BCallExpression%5D%401|sha256=b4658de8dbe7837e74b49afb941fb12df1f88ae14e7a0aad3e8c6ce359741377",
        identity: "src/workflow/durable-workflow-store.ts#parseTrigger[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 360,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseTrigger%5BCallExpression%5D%401|sha256=bbd0a5f27847881aa2334bb92500bd284f11d440086b2177df3ef54cac774e5a",
        identity: "src/workflow/durable-workflow-store.ts#parseTrigger[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 361,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseBinding%5BCallExpression%5D%401|sha256=19423898325fdf39d16906b0237695f4727445a87643f1db603a9cf4ba7cbd11",
        identity: "src/workflow/durable-workflow-store.ts#parseBinding[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 392,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseBinding%5BCallExpression%5D%401|sha256=e636ab4d75bfd351aa7d5dacffb45d1328553d91c5f77a0d5b62086a4bb1a793",
        identity: "src/workflow/durable-workflow-store.ts#parseBinding[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 393,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseAction%5BCallExpression%5D%401|sha256=d57c9a011d0b9ebab3a89e835ec754c838f10495230b8372b6d6a205895fff91",
        identity: "src/workflow/durable-workflow-store.ts#parseAction[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 410,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseAction%5BCallExpression%5D%401|sha256=1372b4ece36c58ae53ef1427d451fcab41b42cf6a9726e4ec9bec85cebefc7b4",
        identity: "src/workflow/durable-workflow-store.ts#parseAction[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 411,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseRequestTerminalReceipt%5BCallExpression%5D%401|sha256=890d3013aa116c2b93837f20368ef3d7094eac57382da33d81f0912e6bf4f453",
        identity:
          "src/workflow/durable-workflow-store.ts#parseRequestTerminalReceipt[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 431,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseRequestTerminalReceipt%5BCallExpression%5D%401|sha256=df4b2dfadd37eadcff9eb3a0706e7a082dfb3d4061403c552d5f924b73376ca6",
        identity:
          "src/workflow/durable-workflow-store.ts#parseRequestTerminalReceipt[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 442,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseRequestTerminalReceipt%5BCallExpression%5D%401|sha256=736b037b9e4238e4a295a97a795e3d4e95c2027ab789e34cda4cd6216c9b4060",
        identity:
          "src/workflow/durable-workflow-store.ts#parseRequestTerminalReceipt[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 449,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23parseActionOutboxEntry%5BCallExpression%5D%401|sha256=82f94d2034f00b14266a83e6d11003637659fa5d8c417e22477a52cd4a2a387a",
        identity: "src/workflow/durable-workflow-store.ts#parseActionOutboxEntry[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 457,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.listMigrations.%3Ccallback%3E%5BCallExpression%5D%401|sha256=a651b208e92a1e248a6ece72c04e0280392d5b12e93dad55fd190ad1265bf016",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.listMigrations.<callback>[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 651,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.listMigrations.%3Ccallback%3E%5BCallExpression%5D%401|sha256=2bc0c4610df1f1cb18b836cb261456ddd9eaf4b8c68ade49c0c004dab9ef4652",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.listMigrations.<callback>[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 654,
          column: 16,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.createRevision%5BCallExpression%5D%401|sha256=bceab269f55313ed06ab7dc50b8eb60eb397ef64a3963d55dd99eb7b92992353",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.createRevision[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 663,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.createRun%5BCallExpression%5D%401|sha256=b004b0d0afa19ad7cce40ae51a8d95724f116b6e3a873393d1e35e2ef310a04a",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.createRun[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 737,
          column: 17,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.createInvocation%5BCallExpression%5D%401|sha256=0e10d387397ddff3b52cde83dae428638207f72455002fd703adbf953b6be015",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.createInvocation[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 872,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.createInvocation%5BCallExpression%5D%401|sha256=81166ba7b06baf91b0fcf50482b38ed5c3fbee3d64134ca5ac6bde6cab49903e",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.createInvocation[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 873,
          column: 26,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.createInvocation%5BCallExpression%5D%401|sha256=dead5e554d4328fbf1cbf6b00fe5ba834210b700b431a358728b436d862f83d6",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.createInvocation[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 880,
          column: 27,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.getLiveParentDeliverySnapshot%5BCallExpression%5D%401|sha256=a209f120d22d6c9a8eb4181d2a41002ed84ffdaa73ddf9b8c7683358a9a39c47",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.getLiveParentDeliverySnapshot[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 976,
          column: 17,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.getLiveParentDeliveryState%5BCallExpression%5D%401|sha256=58ddfe9c9085316835f078b456261310ee411dffd45f46baab8833f60607380c",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.getLiveParentDeliveryState[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 1014,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.recordLiveParentCompletionMaterializationFailure.%3Ccallback%3E%5BCallExpression%5D%401|sha256=7ec6d76abc3bccf1f0d507ee94e5e56a697e0945e71bd28c6c047160e229e4c5",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.recordLiveParentCompletionMaterializationFailure.<callback>[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 1167,
          column: 14,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.transitionRun%5BCallExpression%5D%401|sha256=0a7fcf6b292c27685613bd38718a63e7041ceca2d36781e11dbb467c1cab17dc",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.transitionRun[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 1234,
          column: 30,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.terminalizeRun.%3Ccallback%3E%5BCallExpression%5D%401|sha256=fe0c5c8ef160d3903b3691f548b5b11461b201054b4c3179c94c93b61140c18e",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.terminalizeRun.<callback>[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 1294,
          column: 57,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.createOperation%5BCallExpression%5D%401|sha256=354642e0522cf2834fffe82b169a0a2ed7da2ecc9f79412321a166716a7289aa",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.createOperation[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 1652,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.matchesWorkflowRequestPolicyIdentity%5BCallExpression%5D%401|sha256=429e440ab221d1aa09f77b16eaa8182bbb8cd585e12fabb768cce092e517b765",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.matchesWorkflowRequestPolicyIdentity[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 1717,
          column: 28,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.authorizeAgentDispatch%5BCallExpression%5D%401|sha256=f2845ddf7d16c964d08d21e30af7d6e26f5fe5dcfcbfecb1ea22aef42a1bd283",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.authorizeAgentDispatch[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 1760,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.authorizeAgentDispatch.%3Ccallback%3E%5BCallExpression%5D%401|sha256=007e8fb7bfca9cc0e0f45ff7b8a4e6b8d74e412b481d49f03385838b04d39ac8",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.authorizeAgentDispatch.<callback>[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 1815,
          column: 32,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.authorizeWorkflowRequest.%3Ccallback%3E%5BCallExpression%5D%401|sha256=133cacf71fb78d46841865bece43ec4853663c7525a1029e2b0c604f7861bdf5",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.authorizeWorkflowRequest.<callback>[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 1887,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.authorizeWorkflowRequest.%3Ccallback%3E%5BCallExpression%5D%401|sha256=8c06e04a13283679c0d741c36eb2f34dfb97ad7a7626f0acd2bdc8a7ad16ce57",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.authorizeWorkflowRequest.<callback>[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 1891,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.recordWorkflowRequestTerminal%5BCallExpression%5D%401|sha256=86703180e814e10f4c54e92b0da5d4756eaafecb60b2bd4cfed17fd464bec396",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.recordWorkflowRequestTerminal[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 1930,
          column: 56,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.recordWorkflowRequestTerminal%5BCallExpression%5D%401|sha256=2a9286c9a0f9345c5929ffe55433905b0b35727efd4009600410a8b6196eeee6",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.recordWorkflowRequestTerminal[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 1931,
          column: 54,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.getWorkflowRequestDispatchPolicy%5BCallExpression%5D%401|sha256=fc423dfda613d29586e7068bf3784e1862eff2abb7094acf4c06f508578d5519",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.getWorkflowRequestDispatchPolicy[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 2005,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.getWorkflowRequestDispatchHandoff.%3Ccallback%3E%5BCallExpression%5D%401|sha256=aad761b591f08b2278e5c3ae66317b7c94820e8f846170fdf0da6e750d9c421b",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.getWorkflowRequestDispatchHandoff.<callback>[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 2042,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.summarizeMeaningfulOperations.%3Ccallback%3E%5BCallExpression%5D%401|sha256=ddd87538f750c71714b558f2a2eea2401e66ebb5b2ea51e1a39d18609685d2f6",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.summarizeMeaningfulOperations.<callback>[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 2236,
          column: 40,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.transitionOperation%5BCallExpression%5D%401|sha256=9a0da021dade0cbd3028561d4470bfcacf6430d4cfaf7a5ca5b33d034c3cf153",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.transitionOperation[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 2308,
          column: 30,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.transitionOperation%5BCallExpression%5D%401|sha256=03506a6e9aead4f8fc50a6c5170f93dc674051175d609233fd790196004861f9",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.transitionOperation[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 2317,
          column: 30,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.createWait%5BCallExpression%5D%401|sha256=6d9cd29fa2893400e3f6baab4f512dd029259641c66402194a3d42d9c629766c",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.createWait[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 2396,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.transitionWait%5BCallExpression%5D%401|sha256=8337bcc3947f1856e9e375b7913bed605aa9a84388fdf06c682bbce47d6f426e",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.transitionWait[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 2696,
          column: 30,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.resolveReplyWaitAndSuppress.%3Ccallback%3E%5BCallExpression%5D%401|sha256=8978bae2469914b310ec15e15be157ad4492cc7d2c303da53939726bfc37cdb3",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.resolveReplyWaitAndSuppress.<callback>[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 2743,
          column: 57,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.createTrigger%5BCallExpression%5D%401|sha256=44a271d079e4a50a9bf32cc1be80851173a331fe16356503f6ec5e41fb41cb2d",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.createTrigger[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 2847,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.createTriggerInvocation%5BCallExpression%5D%401|sha256=e7514dfb70aa7d35bd69bc123d6ced1b2058238e9c8e1342f6d9e10038a168a1",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.createTriggerInvocation[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 2885,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.fireClaimedTrigger%5BCallExpression%5D%401|sha256=317f8cb8411c19d95a589ea637a841e145de2fd56b179166cb2da907e1495727",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.fireClaimedTrigger[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 3046,
          column: 26,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.fireClaimedTrigger%5BCallExpression%5D%401|sha256=5533442e32c8b4a0e8444d4603ef087018904b9edf7a124777342a93683faacf",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.fireClaimedTrigger[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 3047,
          column: 27,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.upsertSurfaceBinding%5BCallExpression%5D%401|sha256=6d883670fc796977d95ed6e38f031a1c18d1bb436e5490f7806ba0546d22edf8",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.upsertSurfaceBinding[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 3149,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.commitSurfaceProjection%5BCallExpression%5D%401|sha256=667ef98bd6cb190d0965b3c52b703b5f04ee2b1f8e70779b4d0d3f06d0527ba6",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.commitSurfaceProjection[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 3181,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.createSurfaceAction%5BCallExpression%5D%401|sha256=c60daee648992cc6c35921b027125e81156100d6d52b5915f0152f4063f370a8",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.createSurfaceAction[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 3223,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fdurable-workflow-store.ts%23DurableWorkflowStore.insertActionOutboxEntry%5BCallExpression%5D%401|sha256=720c83ce3c59bf9b381b91f9c64736b61478ba86ecccccf7e1aac35724feefff",
        identity:
          "src/workflow/durable-workflow-store.ts#DurableWorkflowStore.insertActionOutboxEntry[CallExpression]@1",
        location: {
          file: "src/workflow/durable-workflow-store.ts",
          line: 3458,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsurface%2Fgithub%2Fgithub-adapter.ts%23isGithubCommentAuthoredByActor%5BCallExpression%5D%401|sha256=c854aa9297db740f7eff50024bdbbbe6f095cd1525ab072e6db42746cec5b5b0",
        identity:
          "src/surface/github/github-adapter.ts#isGithubCommentAuthoredByActor[CallExpression]@1",
        location: {
          file: "src/surface/github/github-adapter.ts",
          line: 52,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmcp%2Fcatalog-identity.ts%23catalogToolStableId%5BCallExpression%5D%401|sha256=4a06d97bc27a71260fc2c124426c9ae297d02e01aed685a63544064d7132b422",
        identity: "src/mcp/catalog-identity.ts#catalogToolStableId[CallExpression]@1",
        location: {
          file: "src/mcp/catalog-identity.ts",
          line: 30,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmcp%2Fcatalog-identity.ts%23parseCatalogToolStableId%5BCallExpression%5D%401|sha256=7bd73cc3a74b877f8a12129c19dacab67100ebcb43e0a7650845830764a322b3",
        identity: "src/mcp/catalog-identity.ts#parseCatalogToolStableId[CallExpression]@1",
        location: {
          file: "src/mcp/catalog-identity.ts",
          line: 49,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmcp%2Fcatalog-identity.ts%23baseCatalogToolName%5BCallExpression%5D%401|sha256=925545907e0dbed89ba7ea749f5d584166f95d3b7909e6536767c2bd78348792",
        identity: "src/mcp/catalog-identity.ts#baseCatalogToolName[CallExpression]@1",
        location: {
          file: "src/mcp/catalog-identity.ts",
          line: 79,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmcp%2Fcatalog-identity.ts%23assignCatalogToolNames%5BCallExpression%5D%401|sha256=b903a1811c3a0cc606ba85c1209eea0120e4c6cc5d90515f2d9cc8108dc3d94d",
        identity: "src/mcp/catalog-identity.ts#assignCatalogToolNames[CallExpression]@1",
        location: {
          file: "src/mcp/catalog-identity.ts",
          line: 107,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmcp%2Fconfig.ts%23toConfigInputV1%5BCallExpression%5D%401|sha256=26951a118849e18f681aa16c259453606f403af8d8a2cca8be61d5233d60b2c7",
        identity: "src/mcp/config.ts#toConfigInputV1[CallExpression]@1",
        location: {
          file: "src/mcp/config.ts",
          line: 196,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmcp%2Fconfig.ts%23parseMcpConfigDocument%5BCallExpression%5D%401|sha256=5d5aa6804a89de9e2e48cd0ebe0a578dd6d676d1c86e27e8d85bdb3ecc9c75c3",
        identity: "src/mcp/config.ts#parseMcpConfigDocument[CallExpression]@1",
        location: {
          file: "src/mcp/config.ts",
          line: 210,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmcp%2Fconfig.ts%23parseMcpConfigDocument%5BCallExpression%5D%401|sha256=a06dc40f5fb5c9d59e4b6f5123faeffc38ad76eb6beffe6dad2a63019b17c81d",
        identity: "src/mcp/config.ts#parseMcpConfigDocument[CallExpression]@1",
        location: {
          file: "src/mcp/config.ts",
          line: 221,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmcp%2Fcredential-file.ts%23resolveMcpOAuthCredentialPath%5BCallExpression%5D%401|sha256=748c3274bebf38f10368026aa6881cd03f89ecacd7f8749d80cc90163f44f0b3",
        identity: "src/mcp/credential-file.ts#resolveMcpOAuthCredentialPath[CallExpression]@1",
        location: {
          file: "src/mcp/credential-file.ts",
          line: 69,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmcp%2Fcredential-file.ts%23readMcpOAuthCredentialFile%5BCallExpression%5D%401|sha256=de863984518d039f1932fb925498467c488209acd10168fc667567a95296e437",
        identity: "src/mcp/credential-file.ts#readMcpOAuthCredentialFile[CallExpression]@1",
        location: {
          file: "src/mcp/credential-file.ts",
          line: 82,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmcp%2Fcredential-file.ts%23readMcpOAuthCredentialFile%5BCallExpression%5D%401|sha256=75a727bf1f07b7d9eba6ec57cec34f6b8654b736965a12ef59c92cdcaad0b0ef",
        identity: "src/mcp/credential-file.ts#readMcpOAuthCredentialFile[CallExpression]@1",
        location: {
          file: "src/mcp/credential-file.ts",
          line: 90,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmcp%2Fcredential-file.ts%23writeMcpOAuthCredentialFileAtomic%5BCallExpression%5D%401|sha256=eacd7d36012f08da9abe684296b133b6ef440c1bdf0dc5477bea82a9d5ca6660",
        identity: "src/mcp/credential-file.ts#writeMcpOAuthCredentialFileAtomic[CallExpression]@1",
        location: {
          file: "src/mcp/credential-file.ts",
          line: 102,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftools%2Ftool-env.ts%23parseEntry%5BCallExpression%5D%401|sha256=4debedf82d81ed2ae4388ce5477a8fe5929f83e31c81089cdad133206adacef6",
        identity: "src/tools/tool-env.ts#parseEntry[CallExpression]@1",
        location: {
          file: "src/tools/tool-env.ts",
          line: 56,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftools%2Ftool-env.ts%23parseToolEnv%5BCallExpression%5D%401|sha256=d70002c58385c306c220f3042e19aa1be956eb6fdac7ec7e5771a57ba859c036",
        identity: "src/tools/tool-env.ts#parseToolEnv[CallExpression]@1",
        location: {
          file: "src/tools/tool-env.ts",
          line: 72,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftools%2Ffs%2Ffs.ts%23fsTool.toModelOutput%5BCallExpression%5D%401|sha256=d289a738681410e53ce61f59dc232a6140248cd19006ed4bd5ec26d40cd05a2f",
        identity: "src/tools/fs/fs.ts#fsTool.toModelOutput[CallExpression]@1",
        location: {
          file: "src/tools/fs/fs.ts",
          line: 1344,
          column: 9,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftools%2Ffs%2Ffs.ts%23fsTool.toModelOutput%5BCallExpression%5D%402|sha256=4adb810eba3f92f135560865c0ff7e5de976e554c6f4e59ded99482fd14bce8e",
        identity: "src/tools/fs/fs.ts#fsTool.toModelOutput[CallExpression]@2",
        location: {
          file: "src/tools/fs/fs.ts",
          line: 1409,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftools%2Ffs%2Ffs.ts%23fsTool.toModelOutput%5BCallExpression%5D%403|sha256=a59bc8aa5831d8065be85596c31c200e6458c3ce9219e00b807fab12d440520b",
        identity: "src/tools/fs/fs.ts#fsTool.toModelOutput[CallExpression]@3",
        location: {
          file: "src/tools/fs/fs.ts",
          line: 1501,
          column: 9,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftools%2Fsubagent.ts%23subagentTools.execute%5BCallExpression%5D%401|sha256=ee4affa9d9b80fe4ecabf518afe726d1f8d334e0e8788c0be685bab1e68f4e41",
        identity: "src/tools/subagent.ts#subagentTools.execute[CallExpression]@1",
        location: {
          file: "src/tools/subagent.ts",
          line: 301,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fweb.ts%23Web.callFetch%5BCallExpression%5D%401|sha256=5097cfbbe30261c038e54a255e8d9bfcfbdc6cf08416b0023c0f139414ab99b2",
        identity: "src/tool-server/tools/web.ts#Web.callFetch[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/web.ts",
          line: 709,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fweb.ts%23Web.callSearch%5BCallExpression%5D%401|sha256=90a361a4c833bf769aca267362eb152e4da9815897bf30f9e00cfec9fb047b6e",
        identity: "src/tool-server/tools/web.ts#Web.callSearch[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/web.ts",
          line: 745,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fcontent-inspect.ts%23ContentInspect.call%5BCallExpression%5D%401|sha256=337658bea9bec09bb95c3072a37e9ea7d66ffce9179e6b8f502e40095f14df8d",
        identity: "src/tool-server/tools/content-inspect.ts#ContentInspect.call[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/content-inspect.ts",
          line: 141,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Fvalidation-error-message.ts%23parseToolInput%5BCallExpression%5D%401|sha256=a3810a0d810dba530bdbec65daa15874bbc939bab087d1f780e0b51932538593",
        identity: "src/tool-server/validation-error-message.ts#parseToolInput[CallExpression]@1",
        location: {
          file: "src/tool-server/validation-error-message.ts",
          line: 88,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-definition-store.ts%23WorkflowDefinitionStore.definitionPath%5BCallExpression%5D%401|sha256=c380b237a159cc303d319ac01a45ddfabec4b3919a6628c16dc5eedd8c48ac33",
        identity:
          "src/workflow/workflow-definition-store.ts#WorkflowDefinitionStore.definitionPath[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-definition-store.ts",
          line: 147,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-definition-store.ts%23WorkflowDefinitionStore.get%5BCallExpression%5D%401|sha256=fbcbee050b8e1980a6d75e963d10e24dc78bdb7251cfc941171e6d316a5b8bcc",
        identity:
          "src/workflow/workflow-definition-store.ts#WorkflowDefinitionStore.get[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-definition-store.ts",
          line: 168,
          column: 60,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-definition-store.ts%23WorkflowDefinitionStore.save%5BCallExpression%5D%401|sha256=7ce87b9933e59d9cd6ae3abf2fc7dda7cdca18fe4aea03547d249069e7a8af7b",
        identity:
          "src/workflow/workflow-definition-store.ts#WorkflowDefinitionStore.save[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-definition-store.ts",
          line: 204,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-definition-store.ts%23WorkflowDefinitionStore.list%5BCallExpression%5D%401|sha256=37c1b52e6ac6951174e6310f37cc248b7da15d90b533d8876adea54741751ad1",
        identity:
          "src/workflow/workflow-definition-store.ts#WorkflowDefinitionStore.list[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-definition-store.ts",
          line: 293,
          column: 60,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-definition-store.ts%23WorkflowDefinitionStore.list%5BCallExpression%5D%401|sha256=c792b0487a946d952a6442646f9ce12d98150866c0c1e49e61f9cdbce34eba3f",
        identity:
          "src/workflow/workflow-definition-store.ts#WorkflowDefinitionStore.list[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-definition-store.ts",
          line: 317,
          column: 14,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-artifact-store.ts%23writeWorkflowValueArtifact%5BCallExpression%5D%401|sha256=af0de0bc68722b57232f7e95ab287dd8a6c132a7942b47883bede3267f2f762d",
        identity:
          "src/workflow/workflow-artifact-store.ts#writeWorkflowValueArtifact[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-artifact-store.ts",
          line: 35,
          column: 17,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-artifact-store.ts%23readWorkflowValueArtifact%5BCallExpression%5D%401|sha256=87b496c1bc3218687ba7c896ddf5823791077b35691f5817cb6cef2cd52280e3",
        identity:
          "src/workflow/workflow-artifact-store.ts#readWorkflowValueArtifact[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-artifact-store.ts",
          line: 91,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fprogrammatic-workflow.ts%23redactRun%5BCallExpression%5D%401|sha256=61ea3b12e9ce11a80862a1a7f964edb027f03acecaffe507004a021c3463091d",
        identity: "src/tool-server/tools/programmatic-workflow.ts#redactRun[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/programmatic-workflow.ts",
          line: 175,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fprogrammatic-workflow.ts%23redactTrigger%5BCallExpression%5D%401|sha256=1b499945fc22cb23e4e20f8e56ec6a35d33ec65d046a5de3657c3e02567eba0f",
        identity: "src/tool-server/tools/programmatic-workflow.ts#redactTrigger[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/programmatic-workflow.ts",
          line: 185,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fprogrammatic-workflow.ts%23ProgrammaticWorkflow.call%5BCallExpression%5D%401|sha256=acda31c09d56a13d3476126937c5d4e9673d2e8189c7d74074fdae30bc929650",
        identity:
          "src/tool-server/tools/programmatic-workflow.ts#ProgrammaticWorkflow.call[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/programmatic-workflow.ts",
          line: 510,
          column: 53,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fprogrammatic-workflow.ts%23ProgrammaticWorkflow.call%5BCallExpression%5D%401|sha256=b0c47a5a04dc198a32e0798f8467bab12f8532471bcbe35f69dc348138928d7e",
        identity:
          "src/tool-server/tools/programmatic-workflow.ts#ProgrammaticWorkflow.call[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/programmatic-workflow.ts",
          line: 531,
          column: 9,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fprogrammatic-workflow.ts%23ProgrammaticWorkflow.call%5BCallExpression%5D%401|sha256=cb1d7d31ca7e8de5f3d947ebe41176a474f8923e3b5b3c96d94744d9d8f9b04d",
        identity:
          "src/tool-server/tools/programmatic-workflow.ts#ProgrammaticWorkflow.call[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/programmatic-workflow.ts",
          line: 539,
          column: 9,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fprogrammatic-workflow.ts%23ProgrammaticWorkflow.call%5BCallExpression%5D%402|sha256=df0b7f482f7ab405c7509b82938d44c3a647637fef54a84ec79df2dd83df08f5",
        identity:
          "src/tool-server/tools/programmatic-workflow.ts#ProgrammaticWorkflow.call[CallExpression]@2",
        location: {
          file: "src/tool-server/tools/programmatic-workflow.ts",
          line: 735,
          column: 53,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fprogrammatic-workflow.ts%23ProgrammaticWorkflow.call%5BCallExpression%5D%401|sha256=0debb798f053ab8fe6ebb19670d601f20a5975d83dd0b5d5c4aa9b9a7e93e36d",
        identity:
          "src/tool-server/tools/programmatic-workflow.ts#ProgrammaticWorkflow.call[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/programmatic-workflow.ts",
          line: 751,
          column: 9,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fprogrammatic-workflow.ts%23ProgrammaticWorkflow.call%5BCallExpression%5D%401|sha256=f6bcefebb59b9da2de35ffe4e33f0be6322571d4d809fee0b25f3e36170c4140",
        identity:
          "src/tool-server/tools/programmatic-workflow.ts#ProgrammaticWorkflow.call[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/programmatic-workflow.ts",
          line: 758,
          column: 9,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fsurface.ts%23Surface.callHelp%5BCallExpression%5D%401|sha256=fc3f476a4b43144a971f14b624f0ec26047fd0b768466607f050e3b05a365b95",
        identity: "src/tool-server/tools/surface.ts#Surface.callHelp[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/surface.ts",
          line: 1521,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fsurface.ts%23Surface.callActivitiesRecentAgentWrites%5BCallExpression%5D%401|sha256=d7abbd71ef881bad3656b6119008bec67f3cfa7a14b21bc5d7273d68f3541970",
        identity:
          "src/tool-server/tools/surface.ts#Surface.callActivitiesRecentAgentWrites[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/surface.ts",
          line: 1684,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fsurface.ts%23Surface.callSessionsList%5BCallExpression%5D%401|sha256=0cdd3bce64d4d56ffa6766fe325429808c924b71a63bb2e5f7727b8c2202caf6",
        identity: "src/tool-server/tools/surface.ts#Surface.callSessionsList[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/surface.ts",
          line: 1809,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fsurface.ts%23Surface.callSessionsListParticipants%5BCallExpression%5D%401|sha256=8957721be8d43976aad750b16eb9ccdc6c7632e8ce7c0e9ad0abe95a2c026bf5",
        identity:
          "src/tool-server/tools/surface.ts#Surface.callSessionsListParticipants[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/surface.ts",
          line: 1870,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fsurface.ts%23Surface.callMessagesList%5BCallExpression%5D%401|sha256=defa862ab76e8ef746153133e22069c3193d30ed8815ff7c13c96f1ea85cf22b",
        identity: "src/tool-server/tools/surface.ts#Surface.callMessagesList[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/surface.ts",
          line: 1926,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fsurface.ts%23Surface.callMessagesRead%5BCallExpression%5D%401|sha256=22f65f2567ce61296c94186720d809b5be1e017382921753914cc53a83167263",
        identity: "src/tool-server/tools/surface.ts#Surface.callMessagesRead[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/surface.ts",
          line: 2047,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fsurface.ts%23Surface.callMessagesSearch%5BCallExpression%5D%401|sha256=a6dbd2dddaf72fc70fe1114efa55e757cb54a84080ff12c4ab5fed0bab6f4bce",
        identity: "src/tool-server/tools/surface.ts#Surface.callMessagesSearch[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/surface.ts",
          line: 2205,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fsurface.ts%23Surface.callMessagesSend%5BCallExpression%5D%401|sha256=2fef00a44870484749613e4bf3f70b30088e97228319c0cf1b0203a620118425",
        identity: "src/tool-server/tools/surface.ts#Surface.callMessagesSend[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/surface.ts",
          line: 2308,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fsurface.ts%23Surface.callMessagesEdit%5BCallExpression%5D%401|sha256=83c4c8dcd166e8cd06dd4c27e4ac987d7cbbb7147f55c7e07ffb82726aa05725",
        identity: "src/tool-server/tools/surface.ts#Surface.callMessagesEdit[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/surface.ts",
          line: 2413,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fsurface.ts%23Surface.callMessagesDelete%5BCallExpression%5D%401|sha256=f289a2ddafc0baf9f6c25bad97304be4b839a07d73038c7683765b5a4ea8cf9b",
        identity: "src/tool-server/tools/surface.ts#Surface.callMessagesDelete[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/surface.ts",
          line: 2475,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fsurface.ts%23Surface.callReactionsList%5BCallExpression%5D%401|sha256=5f51d8cc566d89e2e07c64c0e1c54ae72768b72136eeaec58efdf98e21549ed2",
        identity: "src/tool-server/tools/surface.ts#Surface.callReactionsList[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/surface.ts",
          line: 2533,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fsurface.ts%23Surface.callReactionsListDetailed%5BCallExpression%5D%401|sha256=d26c7ace696acadc4daa0319ba91fa73014dd6484a46eaec8b0910271a51ee93",
        identity:
          "src/tool-server/tools/surface.ts#Surface.callReactionsListDetailed[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/surface.ts",
          line: 2611,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fsurface.ts%23Surface.callReactionsAdd%5BCallExpression%5D%401|sha256=f12fa823561fc86d64654199bf788bb6226c0dfd23490800ac176d899be4f311",
        identity: "src/tool-server/tools/surface.ts#Surface.callReactionsAdd[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/surface.ts",
          line: 2702,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fsurface.ts%23Surface.callReactionsRemove%5BCallExpression%5D%401|sha256=89cb50e909a101d1cd0f02cb773cf1b1043a3753a63f4eced2eb3e43d640c013",
        identity: "src/tool-server/tools/surface.ts#Surface.callReactionsRemove[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/surface.ts",
          line: 2771,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fskills.ts%23Skills.call%5BCallExpression%5D%401|sha256=c0f1518d00fbdd37694997bc6edf0f8a67f070ce2e939563afc7163f8cc5d127",
        identity: "src/tool-server/tools/skills.ts#Skills.call[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/skills.ts",
          line: 164,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fskills.ts%23Skills.call%5BCallExpression%5D%401|sha256=c17596e488fd7cafc2d7cc818ccb015440c22eef3e17c5b9ba037912dab321b2",
        identity: "src/tool-server/tools/skills.ts#Skills.call[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/skills.ts",
          line: 186,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fcodex.ts%23Codex.call%5BCallExpression%5D%401|sha256=e86abc539155509d220393ab9cf3a33f85e8d2250c32b38c2270bbb6d8c5b7f4",
        identity: "src/tool-server/tools/codex.ts#Codex.call[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/codex.ts",
          line: 139,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fcodex.ts%23Codex.call%5BCallExpression%5D%401|sha256=78b2c8f79341b958b157d9e017babb9864efc326ca21a0434ed00fd8274b4005",
        identity: "src/tool-server/tools/codex.ts#Codex.call[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/codex.ts",
          line: 196,
          column: 7,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fcodex.ts%23Codex.call%5BCallExpression%5D%401|sha256=af7c05feff54e133f500e3e90c73c7f55c7ad9a5bd940b4708431e6ef09b2227",
        identity: "src/tool-server/tools/codex.ts#Codex.call[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/codex.ts",
          line: 207,
          column: 7,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fgenerate.ts%23Generate.callGenerateImage%5BCallExpression%5D%401|sha256=a1f370183c755f39640255c0ac1be0874d75069a87e25d8cd9d8302c5c1033f5",
        identity: "src/tool-server/tools/generate.ts#Generate.callGenerateImage[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/generate.ts",
          line: 916,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fgenerate.ts%23Generate.callGenerateVideo%5BCallExpression%5D%401|sha256=3d1d41f06ed747f94b2fc4c2db6788d261d799a1a7cba8780699ceed5dab4946",
        identity: "src/tool-server/tools/generate.ts#Generate.callGenerateVideo[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/generate.ts",
          line: 971,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fonboarding.ts%23fetchGithubLatestRelease%5BCallExpression%5D%401|sha256=89b75e2ed7550d65039579fcb09c419d2b1d57dad866cab4bb527d98cbcc700a",
        identity: "src/tool-server/tools/onboarding.ts#fetchGithubLatestRelease[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/onboarding.ts",
          line: 504,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fonboarding.ts%23Onboarding.call%5BCallExpression%5D%401|sha256=f006061e4b2767d3c778af667eda724bd9e5533251359693781054eca4ae7b91",
        identity: "src/tool-server/tools/onboarding.ts#Onboarding.call[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/onboarding.ts",
          line: 778,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fonboarding.ts%23Onboarding.call%5BCallExpression%5D%401|sha256=5a6ed693f5664dd16450cfe320607c81a44dc3dd76b46f0fd329223c1bb967e9",
        identity: "src/tool-server/tools/onboarding.ts#Onboarding.call[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/onboarding.ts",
          line: 792,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fonboarding.ts%23Onboarding.call%5BCallExpression%5D%401|sha256=b785c87773ffa67eab257418b6d672b6ddf48a749c8175cf54fdbe20398c9ab8",
        identity: "src/tool-server/tools/onboarding.ts#Onboarding.call[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/onboarding.ts",
          line: 912,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fonboarding.ts%23Onboarding.call%5BCallExpression%5D%401|sha256=0a8c3065f35af3a5c9975b4c1f8c37070c3c01f7ff4fab7611340ed17637b4f6",
        identity: "src/tool-server/tools/onboarding.ts#Onboarding.call[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/onboarding.ts",
          line: 1041,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fonboarding.ts%23Onboarding.call%5BCallExpression%5D%401|sha256=0c4897843a2252ed115e9e05875fc7370adef5b7516e2625ee6323439769a648",
        identity: "src/tool-server/tools/onboarding.ts#Onboarding.call[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/onboarding.ts",
          line: 1071,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fonboarding.ts%23Onboarding.call%5BCallExpression%5D%401|sha256=e40fff1ebae8a3cd9a5c3df05bbbe6437cd6fd301e0228d2f51b51753ba3622a",
        identity: "src/tool-server/tools/onboarding.ts#Onboarding.call[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/onboarding.ts",
          line: 1101,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fonboarding.ts%23Onboarding.call%5BCallExpression%5D%401|sha256=20f8b0291fff9d04f59daf7c171561cba89f1652b900159234a0b83beb80bc62",
        identity: "src/tool-server/tools/onboarding.ts#Onboarding.call[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/onboarding.ts",
          line: 1308,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fonboarding.ts%23Onboarding.call%5BCallExpression%5D%401|sha256=4ac0d6fb38df09aaf7091b7cb784afcab2bc0a920047a479ea212bb644ef6b02",
        identity: "src/tool-server/tools/onboarding.ts#Onboarding.call[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/onboarding.ts",
          line: 1432,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fonboarding.ts%23Onboarding.call%5BCallExpression%5D%401|sha256=e87115e9fec0b6f91f83da5b20a1ac9d3e2502188355ffbe27ffd858609ccccd",
        identity: "src/tool-server/tools/onboarding.ts#Onboarding.call[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/onboarding.ts",
          line: 1566,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fonboarding.ts%23Onboarding.call%5BCallExpression%5D%401|sha256=cf0b9e1e280170b72f4e29d709f384d619f57febbf4941efaa3c0f8e292dda0d",
        identity: "src/tool-server/tools/onboarding.ts#Onboarding.call[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/onboarding.ts",
          line: 1591,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fssh.ts%23SSH.call%5BCallExpression%5D%401|sha256=d9781c8a9cf12ec9eac9ee3e9eb9aea559c75ff32d8dd331563ff4a83438f2ae",
        identity: "src/tool-server/tools/ssh.ts#SSH.call[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/ssh.ts",
          line: 210,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Ftools%2Fssh.ts%23SSH.call%5BCallExpression%5D%401|sha256=11af0a8e4d1ebdc7c16d65e80aa2b2b6fc12f5c8597b231d19029a81fc73c828",
        identity: "src/tool-server/tools/ssh.ts#SSH.call[CallExpression]@1",
        location: {
          file: "src/tool-server/tools/ssh.ts",
          line: 321,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmcp%2Fcatalog.ts%23createPortableToolSearch%5BCallExpression%5D%401|sha256=a2f0a52f2a88856ff9f7292a1bc9864600cc71cc40655df9b9d8d3e8df2bdf59",
        identity: "src/mcp/catalog.ts#createPortableToolSearch[CallExpression]@1",
        location: {
          file: "src/mcp/catalog.ts",
          line: 326,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmcp%2Fregistry.ts%23isOptionalHttpInboundSseError%5BCallExpression%5D%401|sha256=ec38cf14c13456a3f87ee1c91b7db2d19b48857336d079f59b7ac2ea2fac7e09",
        identity: "src/mcp/registry.ts#isOptionalHttpInboundSseError[CallExpression]@1",
        location: {
          file: "src/mcp/registry.ts",
          line: 230,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmcp%2Fregistry.ts%23McpRegistry.wrapToolExecution.execute.%3Ccallback%3E%5BCallExpression%5D%401|sha256=6f425fff863571414d783b16084e6d275ee4c38c302bc77a80c0ed55a450410e",
        identity:
          "src/mcp/registry.ts#McpRegistry.wrapToolExecution.execute.<callback>[CallExpression]@1",
        location: {
          file: "src/mcp/registry.ts",
          line: 751,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmcp%2Fregistry.ts%23McpRegistry.wrapToolExecution.execute%5BCallExpression%5D%401|sha256=43dcdbcf3287b6925cafe774591590e9c3a404f006d1edafdf686915a773b573",
        identity: "src/mcp/registry.ts#McpRegistry.wrapToolExecution.execute[CallExpression]@1",
        location: {
          file: "src/mcp/registry.ts",
          line: 759,
          column: 16,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fplugins%2Fmanager.ts%23createCoreToolPluginManager.buildLevel1Toolset%5BCallExpression%5D%401|sha256=aebbd114a8d456b76680d04b7ce397f57c3e02b6c4d5b9d234b7ca5c57ba41be",
        identity:
          "src/plugins/manager.ts#createCoreToolPluginManager.buildLevel1Toolset[CallExpression]@1",
        location: {
          file: "src/plugins/manager.ts",
          line: 293,
          column: 26,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ftool-server%2Frequest-message-cache.ts%23resolveAuthenticatedOrigin%5BCallExpression%5D%401|sha256=8dbe1818af603edaee3de2c40be6b34b5426701954d95fa6babf5b6795e34069",
        identity:
          "src/tool-server/request-message-cache.ts#resolveAuthenticatedOrigin[CallExpression]@1",
        location: {
          file: "src/tool-server/request-message-cache.ts",
          line: 80,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fconversation%2Fthread-materializer-worker-isolate.ts%23%3Ccallback%3E%5BCallExpression%5D%401|sha256=36feb435222caaef4b2a4cdd70d8d66a80870268203e1a9a5bf8aaf80efe5828",
        identity:
          "src/conversation/thread-materializer-worker-isolate.ts#<callback>[CallExpression]@1",
        location: {
          file: "src/conversation/thread-materializer-worker-isolate.ts",
          line: 82,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fconversation%2Fthread-materializer-worker.ts%23startConversationThreadMaterializer.configureWorker.%3Ccallback%3E%5BCallExpression%5D%401|sha256=e951244cf648ab91727408dac62f21f8825857c7c7777370b61ca819ebbdb509",
        identity:
          "src/conversation/thread-materializer-worker.ts#startConversationThreadMaterializer.configureWorker.<callback>[CallExpression]@1",
        location: {
          file: "src/conversation/thread-materializer-worker.ts",
          line: 69,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fgithub%2Fwebhook%2Fgithub-webhook-server.ts%23onIssueCommentCreated%5BCallExpression%5D%401|sha256=13791a2fe67c2e34202dcb032c4a151d12f818d889fed7e8ccabe16a9c87d617",
        identity:
          "src/github/webhook/github-webhook-server.ts#onIssueCommentCreated[CallExpression]@1",
        location: {
          file: "src/github/webhook/github-webhook-server.ts",
          line: 501,
          column: 25,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fgithub%2Fwebhook%2Fgithub-webhook-server.ts%23onReviewRequested%5BCallExpression%5D%401|sha256=d98819ca8126379bdb2110ad4c22b595241b7b205ba579410e472dffd758fcaf",
        identity: "src/github/webhook/github-webhook-server.ts#onReviewRequested[CallExpression]@1",
        location: {
          file: "src/github/webhook/github-webhook-server.ts",
          line: 679,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23parseWorkflowRequestHintFromRaw%5BCallExpression%5D%401|sha256=fe15e2e326e0c5e2006650a93d1d23d4f1afbe613dab367d45995fb46861ec58",
        identity:
          "src/surface/bridge/bus-agent-runner/raw.ts#parseWorkflowRequestHintFromRaw[CallExpression]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 119,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23parseRouterRaw%5BCallExpression%5D%401|sha256=ad56714705d47556e62528ac8be6400a8ddb5ae38a70d6c74be8218bd7e6e072",
        identity: "src/surface/bridge/bus-agent-runner/raw.ts#parseRouterRaw[CallExpression]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 124,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23parseRequestControlFromRaw%5BCallExpression%5D%401|sha256=41664070c02f2dd2cf1da7c91ccf1bf1b6fa0f000b4e597d30cc775dfcb1ff9a",
        identity:
          "src/surface/bridge/bus-agent-runner/raw.ts#parseRequestControlFromRaw[CallExpression]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 152,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23parseSubagentMetaFromRaw%5BCallExpression%5D%401|sha256=3101702a13f6396c8eb36b3cef104b122083c3aba1af79cfe656bfaee63f2ff3",
        identity:
          "src/surface/bridge/bus-agent-runner/raw.ts#parseSubagentMetaFromRaw[CallExpression]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 194,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner%2Fraw.ts%23parseCustomCommandFromRaw%5BCallExpression%5D%401|sha256=45020c22a1a0eb37fbe26bde60f3fa33aedd5e2daa548e08a2a5f4cd2f867fcb",
        identity:
          "src/surface/bridge/bus-agent-runner/raw.ts#parseCustomCommandFromRaw[CallExpression]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner/raw.ts",
          line: 225,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsurface%2Fbridge%2Fbus-agent-runner.ts%23appendAutoInjectedThreadSearchLineage%5BCallExpression%5D%401|sha256=a699ab294171a879862cea121bcd92b9476eb7944ebc12dc3451374a05019634",
        identity:
          "src/surface/bridge/bus-agent-runner.ts#appendAutoInjectedThreadSearchLineage[CallExpression]@1",
        location: {
          file: "src/surface/bridge/bus-agent-runner.ts",
          line: 1359,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-action-resolver.ts%23startWorkflowActionResolver.drainOutbox%5BCallExpression%5D%401|sha256=940bd4f9b0a3d0d2e5cedce0ff9c56cfc81a23b45268d5ec85d6c5dbfdc7f543",
        identity:
          "src/workflow/workflow-action-resolver.ts#startWorkflowActionResolver.drainOutbox[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-action-resolver.ts",
          line: 56,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-action-resolver.ts%23startWorkflowActionResolver.drainOutbox%5BCallExpression%5D%401|sha256=87881e960cdc260bee30db84c3c830fe285ec6fcf10e3ae503d20822f2583c12",
        identity:
          "src/workflow/workflow-action-resolver.ts#startWorkflowActionResolver.drainOutbox[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-action-resolver.ts",
          line: 62,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-action-resolver.ts%23startWorkflowActionResolver.%3Ccallback%3E%5BCallExpression%5D%401|sha256=5c5e62eb0ebdde7329d1fea148a445f198b9c31da5db83b969c2ac0503730597",
        identity:
          "src/workflow/workflow-action-resolver.ts#startWorkflowActionResolver.<callback>[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-action-resolver.ts",
          line: 108,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-source-compiler.ts%23parseWorkflowCallSiteManifest%5BCallExpression%5D%401|sha256=e0fc618c8d52b35f68d41bae177ea0579a13eff1d47a677d7127179407f5feeb",
        identity:
          "src/workflow/workflow-source-compiler.ts#parseWorkflowCallSiteManifest[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-source-compiler.ts",
          line: 37,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-sandbox.ts%23startWorkflowSandbox.%3Ccallback%3E%5BCallExpression%5D%401|sha256=c562209ea7bc15686b3b9af6959fccb405a6e9a2797f8c51b6140c3dcc63fe3f",
        identity:
          "src/workflow/workflow-sandbox.ts#startWorkflowSandbox.<callback>[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-sandbox.ts",
          line: 190,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-sandbox.ts%23startWorkflowSandbox.%3Ccallback%3E%5BCallExpression%5D%401|sha256=441254d8e7bc5707112c0a351a2375df7619cf863410247cb92c77344aabbe8d",
        identity:
          "src/workflow/workflow-sandbox.ts#startWorkflowSandbox.<callback>[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-sandbox.ts",
          line: 221,
          column: 27,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-sandbox.ts%23startWorkflowSandbox.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%401|sha256=1adf2da20653cf755be83d6f324db9e28c457e7cbbe6ab754f2b11b2c6938ff1",
        identity:
          "src/workflow/workflow-sandbox.ts#startWorkflowSandbox.<callback>.<callback>[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-sandbox.ts",
          line: 236,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-sandbox.ts%23startWorkflowSandbox.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%401|sha256=c8d260c38544823a19e89293858dbdb7944d797e9b500cd11338f4046f52443a",
        identity:
          "src/workflow/workflow-sandbox.ts#startWorkflowSandbox.<callback>.<callback>[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-sandbox.ts",
          line: 242,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-engine.ts%23WorkflowEngine.assertPersistedIntegrity%5BCallExpression%5D%401|sha256=0120a2168f08f82a3b06bb24d43a12dbdbc47a1ada7ced763a0ecab75a469bf4",
        identity:
          "src/workflow/workflow-engine.ts#WorkflowEngine.assertPersistedIntegrity[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 396,
          column: 9,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-engine.ts%23WorkflowEngine.assertPersistedIntegrity%5BCallExpression%5D%401|sha256=874ab3abded0dc14543b0a11bc488e00d48e575a625b4fb53eb81e98ba1ae5c3",
        identity:
          "src/workflow/workflow-engine.ts#WorkflowEngine.assertPersistedIntegrity[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 416,
          column: 9,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-engine.ts%23WorkflowEngine.handleCall%5BCallExpression%5D%401|sha256=151b4d257477f39c7af2ade1f4bbecfe2a1d30db00ed430fb2ec3f8f23c520c1",
        identity: "src/workflow/workflow-engine.ts#WorkflowEngine.handleCall[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 484,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-engine.ts%23WorkflowEngine.handleCall%5BCallExpression%5D%401|sha256=8023e1f4f1de3d59df46398d3732d733650e7a0678df9f5667442a5ac8d3d78e",
        identity: "src/workflow/workflow-engine.ts#WorkflowEngine.handleCall[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 515,
          column: 28,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-engine.ts%23WorkflowEngine.handleCall%5BCallExpression%5D%402|sha256=95a7ad035cf2ddab5fd6da76a43af1f3f19e526923047d22e052e564d4cefa2c",
        identity: "src/workflow/workflow-engine.ts#WorkflowEngine.handleCall[CallExpression]@2",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 527,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-engine.ts%23WorkflowEngine.handleCall%5BCallExpression%5D%403|sha256=24a90ed13d08e64ce8e8773f3dff8cc653a06a52668e0b215c4ce565c5c6f7cf",
        identity: "src/workflow/workflow-engine.ts#WorkflowEngine.handleCall[CallExpression]@3",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 536,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-engine.ts%23WorkflowEngine.handleCall%5BCallExpression%5D%401|sha256=8bac47ab9feffeea6cb03da001377bf6115f79c1e96c4b650c1538fdb03c7f11",
        identity: "src/workflow/workflow-engine.ts#WorkflowEngine.handleCall[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 538,
          column: 14,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-engine.ts%23WorkflowEngine.handleCall%5BCallExpression%5D%404|sha256=7cf7f795a314835b01b712ac52ed932aba429558239b829e9cbb10a0e85c3dd2",
        identity: "src/workflow/workflow-engine.ts#WorkflowEngine.handleCall[CallExpression]@4",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 574,
          column: 26,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-engine.ts%23WorkflowEngine.handleCall%5BCallExpression%5D%401|sha256=f5c597439426575a2f277e3998e3988f5c5aaad50a3670dc30755efae40bc72a",
        identity: "src/workflow/workflow-engine.ts#WorkflowEngine.handleCall[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 579,
          column: 32,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-engine.ts%23WorkflowEngine.handleCall%5BCallExpression%5D%401|sha256=ecb5b04829d5c5839ea2c289bf965fb00bbc8c32efea1bbba8e078f3219d22d4",
        identity: "src/workflow/workflow-engine.ts#WorkflowEngine.handleCall[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 580,
          column: 40,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-engine.ts%23WorkflowEngine.handleCall%5BCallExpression%5D%401|sha256=2d265bc3caf7504cba8ad6a8535eb2aa38dcd9b304e73b6ad7b758b57c92e444",
        identity: "src/workflow/workflow-engine.ts#WorkflowEngine.handleCall[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 581,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-engine.ts%23WorkflowEngine.validateOperationInput%5BCallExpression%5D%401|sha256=85d7893a1fd487f53d846b4442606c118ba6bc538231c1f176f70d7d2077d963",
        identity:
          "src/workflow/workflow-engine.ts#WorkflowEngine.validateOperationInput[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 586,
          column: 27,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-engine.ts%23WorkflowEngine.validateOperationInput%5BCallExpression%5D%401|sha256=1b14bf5f0f47b4dd9d91fb30c36dbcc7a93d54fb2c2eed5f1e035122e095c40d",
        identity:
          "src/workflow/workflow-engine.ts#WorkflowEngine.validateOperationInput[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 587,
          column: 32,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-engine.ts%23WorkflowEngine.validateOperationInput%5BCallExpression%5D%401|sha256=48ebda88ed2818cda7e1edfaff9345f1b3613c6de4b63693a583ab0af589b39d",
        identity:
          "src/workflow/workflow-engine.ts#WorkflowEngine.validateOperationInput[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 588,
          column: 35,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-engine.ts%23WorkflowEngine.validateOperationInput%5BCallExpression%5D%401|sha256=4576240a319109ec90253df1f56fd18ffbbab051806e05f075635bde40162fca",
        identity:
          "src/workflow/workflow-engine.ts#WorkflowEngine.validateOperationInput[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 589,
          column: 35,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-engine.ts%23WorkflowEngine.validateOperationInput%5BCallExpression%5D%401|sha256=d16a5b8fdb4e82d0acaf98a23e91c7ec81f5aaccd00dc30a13a8ea11285bb0db",
        identity:
          "src/workflow/workflow-engine.ts#WorkflowEngine.validateOperationInput[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 590,
          column: 39,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-engine.ts%23WorkflowEngine.validateOperationInput%5BCallExpression%5D%401|sha256=5bbf93f159d0c10d4844793b6d5e740b968297f164970f4c046242a1ae800695",
        identity:
          "src/workflow/workflow-engine.ts#WorkflowEngine.validateOperationInput[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 591,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-engine.ts%23WorkflowEngine.waitDurably%5BCallExpression%5D%401|sha256=ef7fa4baaa0a9be28cfc24999f4ddd74bdbe9e5c0299098ab24eb9bbbf3e99c0",
        identity: "src/workflow/workflow-engine.ts#WorkflowEngine.waitDurably[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 611,
          column: 25,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-engine.ts%23WorkflowEngine.waitDurably%5BCallExpression%5D%401|sha256=0dea3118fc0baa5245f2c5bce580e26da6a3b51698d6fb81efdfb6f79c311dc2",
        identity: "src/workflow/workflow-engine.ts#WorkflowEngine.waitDurably[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 655,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-engine.ts%23WorkflowEngine.dispatchAgent%5BCallExpression%5D%401|sha256=43e5d64fb426e7490e841405f15670424172ea0faf019a823a23b92e560806d4",
        identity: "src/workflow/workflow-engine.ts#WorkflowEngine.dispatchAgent[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 920,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-engine.ts%23WorkflowEngine.dispatchAgent%5BCallExpression%5D%401|sha256=52a386ecbbf367179e4b3152a04043e701f02e560f0491f2705d4b5f0bbfba28",
        identity: "src/workflow/workflow-engine.ts#WorkflowEngine.dispatchAgent[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-engine.ts",
          line: 922,
          column: 13,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-waits.ts%23replyToMessageId%5BCallExpression%5D%401|sha256=31eefa5c230db36cf8b91afe59fa8393879f66f6a82393bfe8a3381d357f128d",
        identity: "src/workflow/workflow-waits.ts#replyToMessageId[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-waits.ts",
          line: 36,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkflow%2Fworkflow-waits.ts%23matchWorkflowReplyWait%5BCallExpression%5D%401|sha256=29988cac5964fa3f54b3c99ac908f7d53fcb5a5542dcfb2517a9ece018e43266",
        identity: "src/workflow/workflow-waits.ts#matchWorkflowReplyWait[CallExpression]@1",
        location: {
          file: "src/workflow/workflow-waits.ts",
          line: 51,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fcore|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fssh%2Fremote-js%2Fremote-runner-entry.ts%23main%5BCallExpression%5D%401|sha256=e7b98834d1f8fb2508dd5b466130a5ad0bffb4da09679945534007897a362afe",
        identity: "src/ssh/remote-js/remote-runner-entry.ts#main[CallExpression]@1",
        location: {
          file: "src/ssh/remote-js/remote-runner-entry.ts",
          line: 269,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
    ],
  },
  "apps/mini-lilac": {
    "architecture/no-unregistered-decoder": [
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac|rule=architecture%2Fno-unregistered-decoder|identity=build.ts%23%3Cmodule%3E%5BCallExpression%5D%401|sha256=0697ee81819d4d89b069a1f3d9bdbd59c89d5c21244a73886d30da1ccd78eeca",
        identity: "build.ts#<module>[CallExpression]@1",
        location: {
          file: "build.ts",
          line: 67,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac|rule=architecture%2Fno-unregistered-decoder|identity=install-local.ts%23installLocalPackage%5BCallExpression%5D%401|sha256=0b2fb1470b98f7f30c25b4cbbc1fc750fdec3271e260b1d0993e8afb7c30ec88",
        identity: "install-local.ts#installLocalPackage[CallExpression]@1",
        location: {
          file: "install-local.ts",
          line: 43,
          column: 26,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
    ],
    "architecture/no-domain-unknown": [
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac|rule=architecture%2Fno-domain-unknown|identity=src%2Fmain.ts%23%3Ccallback%3E%5BParameter%5D%401|sha256=a0acbc5cda49a56e6335583fc1b80dad5b02c7910813ba4d68b00232e416bbdd",
        identity: "src/main.ts#<callback>[Parameter]@1",
        location: {
          file: "src/main.ts",
          line: 75,
          column: 13,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
    ],
  },
  "apps/mini-lilac-server": {
    "architecture/no-domain-unknown": [
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-domain-unknown|identity=src%2Fserver.ts%23jsonResponse%5BParameter%5D%401|sha256=9be68bddde883dd93394ed8d7a7767d32100d54bd297a031d2a3bf8d67b920ad",
        identity: "src/server.ts#jsonResponse[Parameter]@1",
        location: {
          file: "src/server.ts",
          line: 84,
          column: 23,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-domain-unknown|identity=src%2Fserver.ts%23errorResponse%5BParameter%5D%401|sha256=701b0ddb3bffba7762479122aec3d37873ee1a6cea8deffdc226ed1ffdd745aa",
        identity: "src/server.ts#errorResponse[Parameter]@1",
        location: {
          file: "src/server.ts",
          line: 155,
          column: 24,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-domain-unknown|identity=src%2Fmain.ts%23main.handleSignal.%3Ccallback%3E%5BParameter%5D%401|sha256=c247b51901b3667f5a3ecdc34185b9ff40cbf93407c798013f73ebffa8c3dcdb",
        identity: "src/main.ts#main.handleSignal.<callback>[Parameter]@1",
        location: {
          file: "src/main.ts",
          line: 768,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
    ],
    "architecture/no-unregistered-decoder": [
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%401|sha256=e6e0547c9b552a6263ac7965be1daa89ef8e7ecbc1f2f4dc6c8da2049a8c811d",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@1",
        location: {
          file: "src/server.ts",
          line: 360,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%401|sha256=3920d9e13a99ad99bad0c8a983cc895d165877c9c75fbe774c36d5a4b7973fff",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@1",
        location: {
          file: "src/server.ts",
          line: 364,
          column: 30,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%401|sha256=47ef8328f12ef8ee5fb850ccdcbf3f608dcee965bb7e3bfb2006bf71a5a7f371",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@1",
        location: {
          file: "src/server.ts",
          line: 422,
          column: 29,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%401|sha256=77948891ddb061bd4706325e534732ec87967f3490fb6800243cc8eb2ebd2857",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@1",
        location: {
          file: "src/server.ts",
          line: 423,
          column: 25,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%402|sha256=6521e4910a9db7ed8d4bc6a5a2595b1eaee7069e3413bdb018583f4f062ad8d1",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@2",
        location: {
          file: "src/server.ts",
          line: 444,
          column: 29,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%403|sha256=1f28a18b887cbadd93af24ed660733cb8d46e1f331147b5280104831e666bf22",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@3",
        location: {
          file: "src/server.ts",
          line: 451,
          column: 29,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%401|sha256=df7fba57fc05be9803b065f83b83c3588e9beea1eef1c40b403ab89af1dabee2",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@1",
        location: {
          file: "src/server.ts",
          line: 459,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%404|sha256=bc2e3e8a3d8788cdb0456dfb399abda68ca5454480b80e24ace9d9053d9f201c",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@4",
        location: {
          file: "src/server.ts",
          line: 481,
          column: 29,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%405|sha256=e16ef02c32735d6bef43b919a95febb8d5f9e190190ad5eaaada75b5aff4ec3a",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@5",
        location: {
          file: "src/server.ts",
          line: 488,
          column: 29,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%401|sha256=480693cc429f57beca8b2fd7b6a7ca19cdc81ec504b426262d16ae04949251c4",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@1",
        location: {
          file: "src/server.ts",
          line: 496,
          column: 32,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%406|sha256=5093a0088c87b6d9dbbceab16bb7639288a5a9734387e6bb4be30a59070ad94d",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@6",
        location: {
          file: "src/server.ts",
          line: 512,
          column: 29,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%401|sha256=cf7cb4f252d12ea9976cbe37d45021b00f75d9b0de04cac1afc41f4eda206253",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@1",
        location: {
          file: "src/server.ts",
          line: 513,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%407|sha256=db1f73f8a267d645476ecde8d0fba0b4524be96ec9ef5a1ae4f4d680ecfca2de",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@7",
        location: {
          file: "src/server.ts",
          line: 525,
          column: 29,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%401|sha256=661b74c12dc1bf4b90103a340e4ba56fe141af7fa4726bb089f84a4f6915f74a",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@1",
        location: {
          file: "src/server.ts",
          line: 526,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%408|sha256=4dabd7bb1ad7c87fc1bde5b5231c3e89168cb45f33d0cbc7adc9cb337aacc96a",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@8",
        location: {
          file: "src/server.ts",
          line: 539,
          column: 31,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%401|sha256=2ab4304ef0fc65ee4bf90bdc24a1e1629521f6c966391bc1f512a731a21649f9",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@1",
        location: {
          file: "src/server.ts",
          line: 540,
          column: 25,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%409|sha256=b7dcbb446c6cbd37aa9ea7b6801a54b443e4c36e6be039036b8139943d5c6f54",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@9",
        location: {
          file: "src/server.ts",
          line: 551,
          column: 29,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%401|sha256=ab4e29bfe716065bfb30909e1a8a4a73b1567f1b03ce3713827cb8f3e90103f4",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@1",
        location: {
          file: "src/server.ts",
          line: 552,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%4010|sha256=e74afa64def592fda4d1025c942cae93d3ec567f90457e23dc851915cbd22d0b",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@10",
        location: {
          file: "src/server.ts",
          line: 563,
          column: 29,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%401|sha256=d27abde47acbf682be7f4914be6ca48a9b288590eef21beff0d6c8142f9a1a01",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@1",
        location: {
          file: "src/server.ts",
          line: 564,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%401|sha256=7aeee0f230750377040bba02fbe83ee83f4a840b8b21698c40c7ade561bbb67d",
        identity:
          "src/server.ts#createMiniLilacServer.<callback>.<callback>.<callback>[CallExpression]@1",
        location: {
          file: "src/server.ts",
          line: 570,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%4011|sha256=a41dd717d0947229002de82b414442df678f0225b0da522d0c4c5072bcb6cea8",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@11",
        location: {
          file: "src/server.ts",
          line: 577,
          column: 29,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%401|sha256=bcef26077f7d776c20b9ced74e03c92083b512700abdad77c106dc9ae66fbffd",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@1",
        location: {
          file: "src/server.ts",
          line: 578,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%401|sha256=0d834e8c0a822638ce77f735b2b176359022593bdfa08502c4caaec27f0a8cf0",
        identity:
          "src/server.ts#createMiniLilacServer.<callback>.<callback>.<callback>[CallExpression]@1",
        location: {
          file: "src/server.ts",
          line: 584,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%4012|sha256=b8a84e68a1a31f688d49fd30a8fd3950ab0933d3fbc2c50b7046abd0648d95c8",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@12",
        location: {
          file: "src/server.ts",
          line: 591,
          column: 29,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%401|sha256=83d787b4a763e2bb4ec72aa6992a9e3a7263ce886787e633b66c38b5be2423e4",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@1",
        location: {
          file: "src/server.ts",
          line: 592,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%4013|sha256=35850f196b6aa3192d5e1b725f91f3b81ea0966dc36c67f7feda4045ef0061c7",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@13",
        location: {
          file: "src/server.ts",
          line: 612,
          column: 29,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%401|sha256=dcd0ccd66029eded3055abbe369a3bd501899fec239306e5178b2d93e6025e63",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@1",
        location: {
          file: "src/server.ts",
          line: 613,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fserver.ts%23createMiniLilacServer.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%401|sha256=1d6070a640991023f646695ce9ed0d9030da468264f3fae15dec5fb61ac7b124",
        identity: "src/server.ts#createMiniLilacServer.<callback>.<callback>[CallExpression]@1",
        location: {
          file: "src/server.ts",
          line: 627,
          column: 7,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmain.ts%23parseCliArgs%5BCallExpression%5D%401|sha256=c63d47c74a692a52a102c14406160f164d3a96319130df9c150028721c6eb8f6",
        identity: "src/main.ts#parseCliArgs[CallExpression]@1",
        location: {
          file: "src/main.ts",
          line: 297,
          column: 39,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmain.ts%23parseCliArgs%5BCallExpression%5D%401|sha256=05e0baa4070c7ca24114c4b752293491ea8b233dce81ada7577d4a7b025cbe67",
        identity: "src/main.ts#parseCliArgs[CallExpression]@1",
        location: {
          file: "src/main.ts",
          line: 312,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmain.ts%23parseCliArgs%5BCallExpression%5D%401|sha256=b6c19b5a5aa4b917df1e086f66aa2ff93cb615affe51b5c5a80bd1f2798197ee",
        identity: "src/main.ts#parseCliArgs[CallExpression]@1",
        location: {
          file: "src/main.ts",
          line: 325,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmain.ts%23parseCliArgs%5BCallExpression%5D%401|sha256=fb3f59931baac79ba1b98d9068a7539af16d4a9b8b6d035ae91f401f62f3db1b",
        identity: "src/main.ts#parseCliArgs[CallExpression]@1",
        location: {
          file: "src/main.ts",
          line: 345,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-server|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmain.ts%23parseCliArgs%5BCallExpression%5D%401|sha256=8b6697be8fe27a6e8ece11a662304172692583545a9c50eef34b0f558f4e195f",
        identity: "src/main.ts#parseCliArgs[CallExpression]@1",
        location: {
          file: "src/main.ts",
          line: 363,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
    ],
  },
  "apps/mini-lilac-tui": {
    "architecture/no-unregistered-decoder": [
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fcli.ts%23parseCliOptions%5BCallExpression%5D%401|sha256=1b7863c27e2aa4e27c107fb53b02996f9417b505eb8dbd9a85369ec3785e99d8",
        identity: "src/cli.ts#parseCliOptions[CallExpression]@1",
        location: {
          file: "src/cli.ts",
          line: 71,
          column: 48,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fpresentation.ts%23sessionPresentation%5BCallExpression%5D%401|sha256=42f420ff9aa568cf07e2dca2b391b3f8a0c31b2b2110588f7bc7857b521c5956",
        identity: "src/presentation.ts#sessionPresentation[CallExpression]@1",
        location: {
          file: "src/presentation.ts",
          line: 32,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23subagentFromTool%5BCallExpression%5D%401|sha256=048ff5327a2ba1bb5d047b91d9f819eefe543136f5ec40f769e86f44e02045b2",
        identity: "src/render.ts#subagentFromTool[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 364,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23subagentFromTool%5BCallExpression%5D%401|sha256=02bca469cf5ceca224ad217e5adcd69027fcbbf76d7242460e4691f2d30f598a",
        identity: "src/render.ts#subagentFromTool[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 365,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23explorationOperation%5BCallExpression%5D%401|sha256=aedab80e99c6ef49e775ae8dda0e791866b03321cd0437bbbbb8821f8d7b8ca1",
        identity: "src/render.ts#explorationOperation[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 500,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23explorationOperation%5BCallExpression%5D%401|sha256=0e062e26e6f565e74db838336d92b9565d43ba84299bcd970e19b58917c2addc",
        identity: "src/render.ts#explorationOperation[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 522,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23explorationOperation%5BCallExpression%5D%401|sha256=1f65f4c8edd3c53d553c5c908bfcd5348f79f5054c9094a4bb024d60834f745e",
        identity: "src/render.ts#explorationOperation[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 538,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23explorationOperation%5BCallExpression%5D%401|sha256=62f7369a7031ae60ef096e47032098d9ee74febb809195e79e05aa3a7f0ef73a",
        identity: "src/render.ts#explorationOperation[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 550,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23patchEdits%5BCallExpression%5D%401|sha256=c5b82f6400de40e60ecbf0a7219ac19741f1b1cd53d9c9f1c873c4b69637ed8e",
        identity: "src/render.ts#patchEdits[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 672,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23fileEdits%5BCallExpression%5D%401|sha256=1863a005d4a9d57b66765d0f2d880a47766c3899fb81bb803e0c1a0b343074e8",
        identity: "src/render.ts#fileEdits[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 706,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23fileEdits%5BCallExpression%5D%401|sha256=8ab0783cf8539065d8a2ce94bc2a93f306664cddea287d75ab7bd2030049847f",
        identity: "src/render.ts#fileEdits[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 708,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23shellOutput%5BCallExpression%5D%401|sha256=e0534663303a9c113bcfeca70e411662975ea2add1bf18cb7c69f36be0b49048",
        identity: "src/render.ts#shellOutput[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 754,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23shellOutputTone%5BCallExpression%5D%401|sha256=d40bb320bc218ef166ba9c66d054f6cbeed5656c639c5edfccf9acb96af2d474",
        identity: "src/render.ts#shellOutputTone[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 781,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23toolEntry%5BCallExpression%5D%401|sha256=9a08d91440798dc1abf176139cb3393fc512270b48b9a33ae93a7c4b2bc65887",
        identity: "src/render.ts#toolEntry[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 866,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23toolEntry%5BCallExpression%5D%401|sha256=e0fb9c4ee52594fd56cdd1c458a6f306626942b8139fa632d292b7a141b9bcf6",
        identity: "src/render.ts#toolEntry[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 914,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23toolSummary%5BCallExpression%5D%401|sha256=d030c81a3fa0297843773e3d3aa8115050e2d3ca1dee5ba9e71be62ac32580d2",
        identity: "src/render.ts#toolSummary[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 1016,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23toolSummary%5BCallExpression%5D%401|sha256=bc64b98118365264c62133613727debf85ed28c2b763dec1de5b465aea3013c6",
        identity: "src/render.ts#toolSummary[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 1020,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23toolSummary%5BCallExpression%5D%402|sha256=e100407ae1da048bbea23e10634ef0ce01ed3741cb888c29690c889eb424a9ce",
        identity: "src/render.ts#toolSummary[CallExpression]@2",
        location: {
          file: "src/render.ts",
          line: 1024,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23toolSummary%5BCallExpression%5D%401|sha256=9b6d8759c73a082031336ffd706746ccc76f64143dac252f1bb3c4be82db42ad",
        identity: "src/render.ts#toolSummary[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 1028,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23toolSummary%5BCallExpression%5D%401|sha256=4ad258ece615a1c0754785d4c8420bd215562971de63a965993f1b8b5c632dc3",
        identity: "src/render.ts#toolSummary[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 1032,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23toolSummary%5BCallExpression%5D%401|sha256=eaf91d42628caa7cc12dac7df53802c3b915bde55e7ed4f33d290f920d6d3dba",
        identity: "src/render.ts#toolSummary[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 1036,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23toolSummary%5BCallExpression%5D%401|sha256=08471c8e5cf6a7e950697db7e6bebb975b12fc1321771d5ec5afedabbc849519",
        identity: "src/render.ts#toolSummary[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 1040,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23toolSummary%5BCallExpression%5D%401|sha256=797b0c9e2e3a4e60be8c2c08f8ba306ef6197c4e801ef998a7f31b1b36084f96",
        identity: "src/render.ts#toolSummary[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 1051,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23toolSummary%5BCallExpression%5D%401|sha256=531c39dc26002727ef03909ae0908c766cfe28980946542658e908abd38e692b",
        identity: "src/render.ts#toolSummary[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 1060,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23toolSummary%5BCallExpression%5D%401|sha256=4aa6597e7034e679e4624c3362fdca5bc96602ac9e39ae9f77ea4c611c798c21",
        identity: "src/render.ts#toolSummary[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 1064,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23toolSummary%5BCallExpression%5D%401|sha256=627512b989ad30488b78d3ec6467347e8c05f0a7b2f3abe5d3aea4e3019b6ea3",
        identity: "src/render.ts#toolSummary[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 1071,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23toolSummary%5BCallExpression%5D%401|sha256=09ad043aa51f047a63a4c63c715e6d44b572bb061aaecfc975f1583f76142f9d",
        identity: "src/render.ts#toolSummary[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 1075,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23toolSummary%5BCallExpression%5D%401|sha256=afbe6f130e41b46f8c0794645f55c088b2db4dc5413ea768fe05787f38f7bb27",
        identity: "src/render.ts#toolSummary[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 1079,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23toolSummary%5BCallExpression%5D%401|sha256=c5f8b5c322628bffeafebf4de706a3b4345e3cfb7061a710d56a8350952b112f",
        identity: "src/render.ts#toolSummary[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 1081,
          column: 26,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23dataEntry%5BCallExpression%5D%401|sha256=77872f244608dc23bef9d1bc80c13554b0a6227a30e37cb835a575db1eb5b171",
        identity: "src/render.ts#dataEntry[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 1110,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23renderInitialMessages.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%401|sha256=cd12c6cd4951d9e9d6aeeb3d379f1cba47e433aa53cbed74a98d9ced9914bcfb",
        identity: "src/render.ts#renderInitialMessages.<callback>.<callback>[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 1256,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23ChunkRenderer.handleData%5BCallExpression%5D%401|sha256=3c9a03f8341723b40e16d6a345e2d20cd645a90c545c95c02f2752adfb20eacf",
        identity: "src/render.ts#ChunkRenderer.handleData[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 1402,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23ChunkRenderer.handleData%5BCallExpression%5D%401|sha256=9c0a7692fb0c1a17e50b489113520538095fded1c0cffe6a42c1c11c785a8cb5",
        identity: "src/render.ts#ChunkRenderer.handleData[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 1407,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23ChunkRenderer.renderToolOutput%5BCallExpression%5D%401|sha256=4ded9a4b051eae14b1602dbcc01150a8947a2ad2100fbd64c63b7324fd83ef89",
        identity: "src/render.ts#ChunkRenderer.renderToolOutput[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 1601,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Frender.ts%23ChunkRenderer.renderToolOutput%5BCallExpression%5D%401|sha256=8215398310f3dd6693f9b94787a0ac59309eeed1495a7627017ebf91036055f0",
        identity: "src/render.ts#ChunkRenderer.renderToolOutput[CallExpression]@1",
        location: {
          file: "src/render.ts",
          line: 1648,
          column: 33,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fcontroller.ts%23Controller.consume%5BCallExpression%5D%401|sha256=40ec35429a436f5ebce9816b5cbee019177f35002fff20379a0a9eaf8050cecd",
        identity: "src/controller.ts#Controller.consume[CallExpression]@1",
        location: {
          file: "src/controller.ts",
          line: 708,
          column: 26,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fcontroller.ts%23Controller.consume%5BCallExpression%5D%401|sha256=fc37283db94f6056b614974d680f9cc58048a30187de71ca519e109abe0ee498",
        identity: "src/controller.ts#Controller.consume[CallExpression]@1",
        location: {
          file: "src/controller.ts",
          line: 711,
          column: 28,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fcontroller.ts%23Controller.consume%5BCallExpression%5D%401|sha256=569625cb8da110ecc1cb5ef75ceaf741fc5475333e734ce0d883426c3063ef29",
        identity: "src/controller.ts#Controller.consume[CallExpression]@1",
        location: {
          file: "src/controller.ts",
          line: 717,
          column: 28,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fpreferences.ts%23loadBindingPreferences%5BCallExpression%5D%401|sha256=ab0c5a8767b281610ef3f8f98d417ee5a8d6e42df6b3c463ddcc7deb5e5804bf",
        identity: "src/preferences.ts#loadBindingPreferences[CallExpression]@1",
        location: {
          file: "src/preferences.ts",
          line: 37,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fpreferences.ts%23saveBindingPreferences%5BCallExpression%5D%401|sha256=845043721103ff0be38b47d1607c874d5feedcada03bc3717cecc986cf799350",
        identity: "src/preferences.ts#saveBindingPreferences[CallExpression]@1",
        location: {
          file: "src/preferences.ts",
          line: 44,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fapp.tsx%23MiniLilacApp.selectPaletteItem%5BCallExpression%5D%401|sha256=06d79519a5dcdff03e854941c3188fa5b57605c6b9cbf72c9baf3cdc1fd0c0d2",
        identity: "src/app.tsx#MiniLilacApp.selectPaletteItem[CallExpression]@1",
        location: {
          file: "src/app.tsx",
          line: 1242,
          column: 40,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
    ],
    "architecture/no-domain-unknown": [
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-domain-unknown|identity=src%2Fclipboard.ts%23ignoreUnavailableClipboard%5BParameter%5D%401|sha256=81192c255efd5fe63376e62540b2a4ca626feedf81379690d1b78808cc7d3899",
        identity: "src/clipboard.ts#ignoreUnavailableClipboard[Parameter]@1",
        location: {
          file: "src/clipboard.ts",
          line: 112,
          column: 37,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-domain-unknown|identity=src%2Fpresentation.ts%23sessionPresentation%5BParameter%5D%401|sha256=3256d474a9d2b9461a0a9b9fe491dd82d3f2a90d0c216fff0419429943152faf",
        identity: "src/presentation.ts#sessionPresentation[Parameter]@1",
        location: {
          file: "src/presentation.ts",
          line: 31,
          column: 37,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-domain-unknown|identity=src%2Frender.ts%23subagentFromTool%5BParameter%5D%401|sha256=e0e183b6f880d89b90d4e465c9cfd33676b46e16c711b15e18e3fb4a214c0064",
        identity: "src/render.ts#subagentFromTool[Parameter]@1",
        location: {
          file: "src/render.ts",
          line: 361,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-domain-unknown|identity=src%2Frender.ts%23subagentFromTool%5BParameter%5D%401|sha256=aa3920b59599e6ce85048e5bc99c9523f724a9b358d9737ef5fd0e9f818415ae",
        identity: "src/render.ts#subagentFromTool[Parameter]@1",
        location: {
          file: "src/render.ts",
          line: 362,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-domain-unknown|identity=src%2Frender.ts%23explorationOperation%5BParameter%5D%401|sha256=ef4c26205d719245122b6666301bb7bc70e6db52f332ba59f0dfacdca54e17b3",
        identity: "src/render.ts#explorationOperation[Parameter]@1",
        location: {
          file: "src/render.ts",
          line: 493,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-domain-unknown|identity=src%2Frender.ts%23rawExplorationInput%5BParameter%5D%401|sha256=4f4b3ad8acb7dbc6a6034b9486d544662bf4519676a52cdfe09d9c52fdd3c1b7",
        identity: "src/render.ts#rawExplorationInput[Parameter]@1",
        location: {
          file: "src/render.ts",
          line: 562,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-domain-unknown|identity=src%2Frender.ts%23patchEdits%5BParameter%5D%401|sha256=9a5bc7a4ec49b0a1561c7ac32dea5b6e79d50e4268a7d15d9deb63252ec94787",
        identity: "src/render.ts#patchEdits[Parameter]@1",
        location: {
          file: "src/render.ts",
          line: 671,
          column: 21,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-domain-unknown|identity=src%2Frender.ts%23fileEdits%5BParameter%5D%401|sha256=a980465bb13b959074df169d80f42a1e332f2b42d3689d14243664d7b3b75a72",
        identity: "src/render.ts#fileEdits[Parameter]@1",
        location: {
          file: "src/render.ts",
          line: 702,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-domain-unknown|identity=src%2Frender.ts%23fileEdits%5BParameter%5D%401|sha256=7c7a7eb7a1338ca3cadb30998c2a19fb56b8a3a1e0030b6caa4f8e89920e1afa",
        identity: "src/render.ts#fileEdits[Parameter]@1",
        location: {
          file: "src/render.ts",
          line: 703,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-domain-unknown|identity=src%2Frender.ts%23shellOutput%5BParameter%5D%401|sha256=c505b4cef1eff5f03b4b5672d0081bebac02e684ef026c5aff21d021472fc399",
        identity: "src/render.ts#shellOutput[Parameter]@1",
        location: {
          file: "src/render.ts",
          line: 752,
          column: 22,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-domain-unknown|identity=src%2Frender.ts%23shellOutputTone%5BParameter%5D%401|sha256=627267780204f4a051e16855f4e5f30c6d9bfbecfbdc13ffb5afe879e5317513",
        identity: "src/render.ts#shellOutputTone[Parameter]@1",
        location: {
          file: "src/render.ts",
          line: 780,
          column: 26,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-domain-unknown|identity=src%2Frender.ts%23toolEntry%5BParameter%5D%401|sha256=bc9db6298c52b353c2d2ba2e1672da544196f093598cba995f6677af8162d583",
        identity: "src/render.ts#toolEntry[Parameter]@1",
        location: {
          file: "src/render.ts",
          line: 859,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-domain-unknown|identity=src%2Frender.ts%23toolSummary%5BParameter%5D%401|sha256=ec5c4ba0a1ba537e0faede5f103d8eed35e3c79c8674a4e50404d971abaae40b",
        identity: "src/render.ts#toolSummary[Parameter]@1",
        location: {
          file: "src/render.ts",
          line: 1014,
          column: 43,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-domain-unknown|identity=src%2Frender.ts%23toolSummary%5BParameter%5D%401|sha256=5e77fa5affcf09bb9c59758e63043b69a449b185bdc2d78f154c0ab1701dc7ae",
        identity: "src/render.ts#toolSummary[Parameter]@1",
        location: {
          file: "src/render.ts",
          line: 1014,
          column: 59,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-domain-unknown|identity=src%2Frender.ts%23ChunkRenderer.renderToolStart%5BParameter%5D%401|sha256=712db909eb430a21f1a5982e87d2dbea34a77cd6fd2d7bf47c0df107f0b08a83",
        identity: "src/render.ts#ChunkRenderer.renderToolStart[Parameter]@1",
        location: {
          file: "src/render.ts",
          line: 1476,
          column: 5,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-domain-unknown|identity=src%2Frender.ts%23ChunkRenderer.renderToolOutput%5BParameter%5D%401|sha256=0616811ed9982bd0b1f898ea14c5d1241fe4ee2ca1b8739cca53b1c9ac4de4dd",
        identity: "src/render.ts#ChunkRenderer.renderToolOutput[Parameter]@1",
        location: {
          file: "src/render.ts",
          line: 1573,
          column: 48,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-domain-unknown|identity=src%2Fcontroller.ts%23errorMessage%5BParameter%5D%401|sha256=47bb8de52595b3fd7aa93f1a0cc88c1a44829603b7586ecc7b3b2ed4ab6ad644",
        identity: "src/controller.ts#errorMessage[Parameter]@1",
        location: {
          file: "src/controller.ts",
          line: 93,
          column: 23,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-domain-unknown|identity=src%2Fcontroller.ts%23Controller.cancelCompaction.%3Ccallback%3E%5BParameter%5D%401|sha256=66630f727d50800cd101861190162197732551fe3a6df3634df9f056db3da77c",
        identity: "src/controller.ts#Controller.cancelCompaction.<callback>[Parameter]@1",
        location: {
          file: "src/controller.ts",
          line: 1283,
          column: 17,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-domain-unknown|identity=src%2Fcontroller.ts%23Controller.commitError%5BParameter%5D%401|sha256=cd0a81af2180dec7d0d6f46f6a07faecd9e2cf1b2a182393ed68be525db3ddca",
        identity: "src/controller.ts#Controller.commitError[Parameter]@1",
        location: {
          file: "src/controller.ts",
          line: 1697,
          column: 23,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-domain-unknown|identity=src%2Fapp.tsx%23isDraftExtmarkData%5BParameter%5D%401|sha256=87825b507b3e24253b7b5fbce8c1ac7b2b5292c7f33ba7dc9443793fd18b26dd",
        identity: "src/app.tsx#isDraftExtmarkData[Parameter]@1",
        location: {
          file: "src/app.tsx",
          line: 2109,
          column: 29,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-domain-unknown|identity=src%2Fmain.tsx%23main.rememberBindings.%3Ccallback%3E%5BParameter%5D%401|sha256=607b2141e77eeec91119b2c87e5c62eae3c1802e77e3d8b1dec5a061b340fc15",
        identity: "src/main.tsx#main.rememberBindings.<callback>[Parameter]@1",
        location: {
          file: "src/main.tsx",
          line: 108,
          column: 15,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-domain-unknown|identity=src%2Fmain.tsx%23%3Ccallback%3E%5BParameter%5D%401|sha256=83abebbdcc3e3f2ec2717749e588704bc01803cb61dd3449131a8a8e2ac815b7",
        identity: "src/main.tsx#<callback>[Parameter]@1",
        location: {
          file: "src/main.tsx",
          line: 215,
          column: 13,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
    ],
    "architecture/no-rich-unknown-predicate": [
      {
        fingerprint:
          "arch-v2|workspace=apps%2Fmini-lilac-tui|rule=architecture%2Fno-rich-unknown-predicate|identity=src%2Fapp.tsx%23isDraftExtmarkData%5BFunctionDeclaration%5D%401|sha256=a173e26c36bfc860528b07d533735341837253d07a80d6c82ac9b9b266088a1b",
        identity: "src/app.tsx#isDraftExtmarkData[FunctionDeclaration]@1",
        location: {
          file: "src/app.tsx",
          line: 2109,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
    ],
  },
  "apps/tool-bridge": {
    "architecture/no-domain-unknown": [
      {
        fingerprint:
          "arch-v2|workspace=apps%2Ftool-bridge|rule=architecture%2Fno-domain-unknown|identity=client.ts%23parseCallableIdsFromListPayload%5BParameter%5D%401|sha256=ac6b74ea2444c643614c3bcea6cac1e4db9be31d310fedc2e42c4aff2e3e654d",
        identity: "client.ts#parseCallableIdsFromListPayload[Parameter]@1",
        location: {
          file: "client.ts",
          line: 151,
          column: 42,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Ftool-bridge|rule=architecture%2Fno-domain-unknown|identity=client.ts%23maybeString%5BParameter%5D%401|sha256=c19c2e710303a8a1cb0882d07426f6612a93b50a2e349be16f2b7030be1921d5",
        identity: "client.ts#maybeString[Parameter]@1",
        location: {
          file: "client.ts",
          line: 175,
          column: 22,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Ftool-bridge|rule=architecture%2Fno-domain-unknown|identity=client.ts%23extractErrorMessage%5BParameter%5D%401|sha256=ec363091202151bc1d30d612aea05f1741f26e2ac3776f1d18ce75f70b8b5f9a",
        identity: "client.ts#extractErrorMessage[Parameter]@1",
        location: {
          file: "client.ts",
          line: 181,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Ftool-bridge|rule=architecture%2Fno-domain-unknown|identity=client.ts%23levenshteinDistance.%3Ccallback%3E%5BParameter%5D%401|sha256=9e19be9c84e71a4cb866517a3106f5640f2cfe6910d4414beb9d2f128b4563f3",
        identity: "client.ts#levenshteinDistance.<callback>[Parameter]@1",
        location: {
          file: "client.ts",
          line: 235,
          column: 56,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Ftool-bridge|rule=architecture%2Fno-domain-unknown|identity=client.ts%23runOnboardingWizard.getStringField%5BParameter%5D%401|sha256=18611a6f823ad9aa452a5c1516d5565db4eb22f9a55992493c9633674411cd13",
        identity: "client.ts#runOnboardingWizard.getStringField[Parameter]@1",
        location: {
          file: "client.ts",
          line: 1334,
          column: 27,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Ftool-bridge|rule=architecture%2Fno-domain-unknown|identity=index.ts%23recordUnhandledRejection%5BParameter%5D%401|sha256=38f15a45e677238b7b7889ec97fd36425072f8ed6859ae25d9f5dc47fac81479",
        identity: "index.ts#recordUnhandledRejection[Parameter]@1",
        location: {
          file: "index.ts",
          line: 33,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Ftool-bridge|rule=architecture%2Fno-domain-unknown|identity=index.ts%23%3Ccallback%3E%5BParameter%5D%401|sha256=5499d255fd73e547a03bfab7c709e9696f2565ac30254c260e92977f269b9a08",
        identity: "index.ts#<callback>[Parameter]@1",
        location: {
          file: "index.ts",
          line: 49,
          column: 35,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
    ],
    "architecture/no-unregistered-decoder": [
      {
        fingerprint:
          "arch-v2|workspace=apps%2Ftool-bridge|rule=architecture%2Fno-unregistered-decoder|identity=client.ts%23parseCallableIdsFromListPayload%5BCallExpression%5D%401|sha256=1d423b3680357879619de32422834d4835058178f185e29e0d6d75a2b83ee2f6",
        identity: "client.ts#parseCallableIdsFromListPayload[CallExpression]@1",
        location: {
          file: "client.ts",
          line: 152,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Ftool-bridge|rule=architecture%2Fno-unregistered-decoder|identity=client.ts%23extractErrorMessage%5BCallExpression%5D%401|sha256=b2954d393b3fb302f1e51267737456cf6d13432dcacbb68b0d23221fcd28f02a",
        identity: "client.ts#extractErrorMessage[CallExpression]@1",
        location: {
          file: "client.ts",
          line: 185,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Ftool-bridge|rule=architecture%2Fno-unregistered-decoder|identity=client.ts%23getBackendVersionInfoBestEffort.%3Ccallback%3E%5BCallExpression%5D%401|sha256=e23182ee5eb6b57da9997ae39ec4b9dea921445fc77a37450f15f70e81561f06",
        identity: "client.ts#getBackendVersionInfoBestEffort.<callback>[CallExpression]@1",
        location: {
          file: "client.ts",
          line: 348,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Ftool-bridge|rule=architecture%2Fno-unregistered-decoder|identity=client.ts%23runOnboardingWizard.getStringField%5BCallExpression%5D%401|sha256=cdfc04e8cc0fe862d07f0f754da5d69faf6a4fec9f24a15450009b6c24647a38",
        identity: "client.ts#runOnboardingWizard.getStringField[CallExpression]@1",
        location: {
          file: "client.ts",
          line: 1335,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=apps%2Ftool-bridge|rule=architecture%2Fno-unregistered-decoder|identity=client.ts%23readJsonObjectSource%5BCallExpression%5D%401|sha256=ce30eb72d2492534b0b7bf7df716045af8d1bd4d6a798317f976c40b0bff27b6",
        identity: "client.ts#readJsonObjectSource[CallExpression]@1",
        location: {
          file: "client.ts",
          line: 1439,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
    ],
  },
  "packages/agent": {
    "architecture/no-domain-unknown": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=tool-call-expansion.ts%23ToolExpansion.constructor%5BParameter%5D%401|sha256=56cdec996944542384c53e8695ce0030b6f53c213813ef60c263d224026fdd13",
        identity: "tool-call-expansion.ts#ToolExpansion.constructor[Parameter]@1",
        location: {
          file: "tool-call-expansion.ts",
          line: 15,
          column: 5,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=tool-call-expansion.ts%23isToolExpansion%5BParameter%5D%401|sha256=25664d4ff3fc01ed4ee4091ff84d5823ab4543566986e69d2d4f2cc1074fa5e9",
        identity: "tool-call-expansion.ts#isToolExpansion[Parameter]@1",
        location: {
          file: "tool-call-expansion.ts",
          line: 20,
          column: 33,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=atomic-tool-execution.ts%23isAsyncIterable%5BParameter%5D%401|sha256=aa37abef7fe91b4dcc39a2b2a7cf89003ee9b0061dd032d8247520378f6dc7b9",
        identity: "atomic-tool-execution.ts#isAsyncIterable[Parameter]@1",
        location: {
          file: "atomic-tool-execution.ts",
          line: 103,
          column: 26,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=atomic-tool-execution.ts%23isInvalidToolInputError%5BParameter%5D%401|sha256=071a53c4853f778a9607717d8184f21b5b697d8026f5755319a57820d4243919",
        identity: "atomic-tool-execution.ts#isInvalidToolInputError[Parameter]@1",
        location: {
          file: "atomic-tool-execution.ts",
          line: 112,
          column: 34,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=atomic-tool-execution.ts%23isJsonToolOutputValue%5BParameter%5D%401|sha256=02bc888d73dea41e594ee4cf5251c3a322eec3625dd931b36da98ec05465f676",
        identity: "atomic-tool-execution.ts#isJsonToolOutputValue[Parameter]@1",
        location: {
          file: "atomic-tool-execution.ts",
          line: 119,
          column: 32,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=atomic-tool-execution.ts%23isJsonToolOutputValueInner%5BParameter%5D%401|sha256=98d34d9efad28a8942d594b6605a5dc8e6870c5bb78c2b381e347533ddb0a8d5",
        identity: "atomic-tool-execution.ts#isJsonToolOutputValueInner[Parameter]@1",
        location: {
          file: "atomic-tool-execution.ts",
          line: 124,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=atomic-tool-execution.ts%23toJsonToolOutputValue%5BParameter%5D%401|sha256=c1801181fe0b1337278a9bb9ecbbf07a0d27ea0b61dc016210b49e1f2d47ea65",
        identity: "atomic-tool-execution.ts#toJsonToolOutputValue[Parameter]@1",
        location: {
          file: "atomic-tool-execution.ts",
          line: 151,
          column: 32,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=atomic-tool-execution.ts%23stringifyToolInput%5BParameter%5D%401|sha256=db83cb5dd173b9f018545694783ec90c7023400ad83311f5db3d41fd6ca58e70",
        identity: "atomic-tool-execution.ts#stringifyToolInput[Parameter]@1",
        location: {
          file: "atomic-tool-execution.ts",
          line: 165,
          column: 29,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=atomic-tool-execution.ts%23invalidInputMessage%5BParameter%5D%401|sha256=09f12939d5fc611dd28df8b03c2e5143a463e33de74e1541838830a18aa51f82",
        identity: "atomic-tool-execution.ts#invalidInputMessage[Parameter]@1",
        location: {
          file: "atomic-tool-execution.ts",
          line: 173,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=atomic-tool-execution.ts%23cleanupFailedAtomicToolCall%5BParameter%5D%401|sha256=bb1231dbdd653bab83ef823f02658c737b877cdd97ca927685eb1706b6320b11",
        identity: "atomic-tool-execution.ts#cleanupFailedAtomicToolCall[Parameter]@1",
        location: {
          file: "atomic-tool-execution.ts",
          line: 386,
          column: 77,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=ai-sdk-pi-agent.ts%23%3Cmodule%3E%5BParameter%5D%401|sha256=f66a47a64fa15060e3936eb8c89727f69e8803204db7a3ca047f6991bf3c95a4",
        identity: "ai-sdk-pi-agent.ts#<module>[Parameter]@1",
        location: {
          file: "ai-sdk-pi-agent.ts",
          line: 435,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=ai-sdk-pi-agent.ts%23%3Cmodule%3E%5BParameter%5D%402|sha256=d8047e97b8ce490f8b6b0888f18d91361551854414c9b1a91903384602d01a21",
        identity: "ai-sdk-pi-agent.ts#<module>[Parameter]@2",
        location: {
          file: "ai-sdk-pi-agent.ts",
          line: 458,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=ai-sdk-pi-agent.ts%23cloneSteeringValue%5BParameter%5D%401|sha256=86ef39f99e61e63a8623a76b5088d26964afece71337754f4590ff1d69227ce9",
        identity: "ai-sdk-pi-agent.ts#cloneSteeringValue[Parameter]@1",
        location: {
          file: "ai-sdk-pi-agent.ts",
          line: 586,
          column: 29,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=ai-sdk-pi-agent.ts%23isClonedModelMessage%5BParameter%5D%401|sha256=2655d833647b78621fef885515dec4a83fb6e37ea62d2376f9db7fc21702f545",
        identity: "ai-sdk-pi-agent.ts#isClonedModelMessage[Parameter]@1",
        location: {
          file: "ai-sdk-pi-agent.ts",
          line: 633,
          column: 31,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=ai-sdk-pi-agent.ts%23recoveryToolOutput%5BParameter%5D%401|sha256=f17446b9cf8c9da6a4a90bf74d3475d6ef258916fe3f37392167663a5712da42",
        identity: "ai-sdk-pi-agent.ts#recoveryToolOutput[Parameter]@1",
        location: {
          file: "ai-sdk-pi-agent.ts",
          line: 958,
          column: 29,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=ai-sdk-pi-agent.ts%23AiSdkPiAgent.setContext%5BParameter%5D%401|sha256=2b13c8bc661e0076b0df9f397c945f33af3e71904a1f2b32a20ab88edbf5ff79",
        identity: "ai-sdk-pi-agent.ts#AiSdkPiAgent.setContext[Parameter]@1",
        location: {
          file: "ai-sdk-pi-agent.ts",
          line: 1213,
          column: 14,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=ai-sdk-pi-agent.ts%23AiSdkPiAgent.requestIdleRecovery%5BParameter%5D%401|sha256=4e68959b5f74da82427af554321c2f399e98b4ef7a573c8b47e84fbfd4fcd712",
        identity: "ai-sdk-pi-agent.ts#AiSdkPiAgent.requestIdleRecovery[Parameter]@1",
        location: {
          file: "ai-sdk-pi-agent.ts",
          line: 1662,
          column: 5,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=context-overflow.ts%23visit%5BParameter%5D%401|sha256=58c873ebfc26424b20ca8d580c4c09dc1464baaf628c5dc0429324a46d70d22d",
        identity: "context-overflow.ts#visit[Parameter]@1",
        location: {
          file: "context-overflow.ts",
          line: 19,
          column: 16,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=context-overflow.ts%23isLikelyContextOverflowError%5BParameter%5D%401|sha256=c9d6785224cd401ce3efe41f05e6a72c07e15d2c93ae38320bb911aeeeeaa8a4",
        identity: "context-overflow.ts#isLikelyContextOverflowError[Parameter]@1",
        location: {
          file: "context-overflow.ts",
          line: 84,
          column: 46,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=openai-server-compaction.ts%23readOpenAIServerCompactionArtifact%5BParameter%5D%401|sha256=7f55c4412749841e593f5d5b2d2e636254aaaef65f455ebb192f4a9570b9531f",
        identity: "openai-server-compaction.ts#readOpenAIServerCompactionArtifact[Parameter]@1",
        location: {
          file: "openai-server-compaction.ts",
          line: 141,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=auto-compaction.ts%23getString%5BParameter%5D%401|sha256=80bb0cdb0ad326a38abbbdfa501800886564f797b271178d6598cded6daf72ec",
        identity: "auto-compaction.ts#getString[Parameter]@1",
        location: {
          file: "auto-compaction.ts",
          line: 26,
          column: 20,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=auto-compaction.ts%23stringifyUnknown%5BParameter%5D%401|sha256=0c91aa17de121bf10f4dc77c1f8f7422a547d5c072de80ef3c31ac78e754da68",
        identity: "auto-compaction.ts#stringifyUnknown[Parameter]@1",
        location: {
          file: "auto-compaction.ts",
          line: 30,
          column: 27,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=auto-compaction.ts%23isDataUrl%5BParameter%5D%401|sha256=5b696912fbe191222eadcd41a825bc650db3aed74b3c1f16c4fd978f79040d4a",
        identity: "auto-compaction.ts#isDataUrl[Parameter]@1",
        location: {
          file: "auto-compaction.ts",
          line: 154,
          column: 20,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=auto-compaction.ts%23withoutInlineMediaPayload%5BParameter%5D%401|sha256=5a76821c2988b3c23abc6d16df12b2678b2a76ba3429f58e951f1eb7139e015a",
        identity: "auto-compaction.ts#withoutInlineMediaPayload[Parameter]@1",
        location: {
          file: "auto-compaction.ts",
          line: 158,
          column: 36,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=auto-compaction.ts%23stringifyTextOnly%5BParameter%5D%401|sha256=1b3229e656ef2598ddf29299ebc41a06d97cc4c4bb378151a2f3df4c7ef8ddb9",
        identity: "auto-compaction.ts#stringifyTextOnly[Parameter]@1",
        location: {
          file: "auto-compaction.ts",
          line: 173,
          column: 28,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=auto-compaction.ts%23stringifyTextOnly.%3Ccallback%3E%5BParameter%5D%401|sha256=5dfb9377487167682deffdb1f6dc6e26b3747ab32810c6a30bcf6c885faaa2a2",
        identity: "auto-compaction.ts#stringifyTextOnly.<callback>[Parameter]@1",
        location: {
          file: "auto-compaction.ts",
          line: 177,
          column: 14,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=auto-compaction.ts%23%3Cmodule%3E%5BParameter%5D%401|sha256=d7bd7a6cc422beb66beed2b4123df173cc3acc5def2a6839350b197ebb35008e",
        identity: "auto-compaction.ts#<module>[Parameter]@1",
        location: {
          file: "auto-compaction.ts",
          line: 1302,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=auto-compaction.ts%23%3Cmodule%3E%5BParameter%5D%402|sha256=58f95adc22b752d1282961f155875682e3e69425cf6808608674ccffd5ffa452",
        identity: "auto-compaction.ts#<module>[Parameter]@2",
        location: {
          file: "auto-compaction.ts",
          line: 1379,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=auto-compaction.ts%23%3Cmodule%3E%5BParameter%5D%403|sha256=fa3effbdf77a8d40bdcd21f670775b44af5e3e8e7d66bb30d12f7891e0366456",
        identity: "auto-compaction.ts#<module>[Parameter]@3",
        location: {
          file: "auto-compaction.ts",
          line: 1428,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=auto-compaction.ts%23isAbortError%5BParameter%5D%401|sha256=7edb0562310c69b4dcebe94f7e3a3984c38c5ffe7848534736e7e1571206144c",
        identity: "auto-compaction.ts#isAbortError[Parameter]@1",
        location: {
          file: "auto-compaction.ts",
          line: 1598,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=auto-compaction.ts%23compactCanonicalMessages%5BParameter%5D%401|sha256=c16f7c737e0556ae0dc7ee3ff3046e496837117ed6e9e8413188e6202c63339f",
        identity: "auto-compaction.ts#compactCanonicalMessages[Parameter]@1",
        location: {
          file: "auto-compaction.ts",
          line: 1857,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=auto-compaction.ts%23attachAutoCompaction.turnErrorHandler%5BParameter%5D%401|sha256=1b3aa46135b42fe98d0b0d8d6845118999a8e3eac8e2df23c7155e1078b07e77",
        identity: "auto-compaction.ts#attachAutoCompaction.turnErrorHandler[Parameter]@1",
        location: {
          file: "auto-compaction.ts",
          line: 2087,
          column: 53,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=session-continuation.ts%23parseStrictJsonValue%5BParameter%5D%401|sha256=bb93075e5d218de3570212f78d909969f98f65a60a5ece20361c075c6b96e505",
        identity: "session-continuation.ts#parseStrictJsonValue[Parameter]@1",
        location: {
          file: "session-continuation.ts",
          line: 226,
          column: 31,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=session-continuation.ts%23normalizeCanonicalValue%5BParameter%5D%401|sha256=52fccdd2ecc5878d5a2012e401d5909453327b4ed9bb59b01ee2bc703d4ea28f",
        identity: "session-continuation.ts#normalizeCanonicalValue[Parameter]@1",
        location: {
          file: "session-continuation.ts",
          line: 294,
          column: 34,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=session-continuation.ts%23canonicalJsonStringify%5BParameter%5D%401|sha256=06489bf20de68eb378427e9c978cfd76366e4554e4126275720d910305849e7b",
        identity: "session-continuation.ts#canonicalJsonStringify[Parameter]@1",
        location: {
          file: "session-continuation.ts",
          line: 298,
          column: 40,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=session-continuation.ts%23fileIdentity%5BParameter%5D%401|sha256=08c986dda09d9e680d65096b05945a0e6a0ed711aefb47368f907e94655bdb7e",
        identity: "session-continuation.ts#fileIdentity[Parameter]@1",
        location: {
          file: "session-continuation.ts",
          line: 302,
          column: 23,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=session-continuation.ts%23valueIsUrlData%5BParameter%5D%401|sha256=0d49770b790656a9bf0b51946e08f4f594b34c107424b34de7400e9cddc64e39",
        identity: "session-continuation.ts#valueIsUrlData[Parameter]@1",
        location: {
          file: "session-continuation.ts",
          line: 346,
          column: 25,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=session-continuation.ts%23projectResultContentItem%5BParameter%5D%401|sha256=685d77b41986481cae83ac180865ec36cad4e9805afc1501477b5fbd261a0333",
        identity: "session-continuation.ts#projectResultContentItem[Parameter]@1",
        location: {
          file: "session-continuation.ts",
          line: 364,
          column: 35,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=session-continuation.ts%23toolOutputProjection%5BParameter%5D%401|sha256=c830524ad000cb3c4da671018c19e066f9460df6c6f852fa340ad8e8eb85ad8b",
        identity: "session-continuation.ts#toolOutputProjection[Parameter]@1",
        location: {
          file: "session-continuation.ts",
          line: 399,
          column: 31,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=session-continuation.ts%23sanitizeReplayValue%5BParameter%5D%401|sha256=0ff05c0cfdf040df9b3e1d50bec087d4e5c29a0d236c9eec9bbd20381e055ad3",
        identity: "session-continuation.ts#sanitizeReplayValue[Parameter]@1",
        location: {
          file: "session-continuation.ts",
          line: 637,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=session-continuation.ts%23safeReplayJsonStringify%5BParameter%5D%401|sha256=a2034032af33d7199a073a3b5a2546b336474474aec7bbed06cdbc244eaccc76",
        identity: "session-continuation.ts#safeReplayJsonStringify[Parameter]@1",
        location: {
          file: "session-continuation.ts",
          line: 703,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=session-continuation.ts%23toolInputText%5BParameter%5D%401|sha256=8f0c317d108bda77ef5026910f7dfbfdf9982298090cad8384004d13f303cb3a",
        identity: "session-continuation.ts#toolInputText[Parameter]@1",
        location: {
          file: "session-continuation.ts",
          line: 712,
          column: 24,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=session-continuation.ts%23toolOutputValueText%5BParameter%5D%401|sha256=88a1f9739ddfbb4e6c6bebb84c9fe0252433b02146cae7d648a8ef5af0556da8",
        identity: "session-continuation.ts#toolOutputValueText[Parameter]@1",
        location: {
          file: "session-continuation.ts",
          line: 720,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=session-continuation.ts%23outputText%5BParameter%5D%401|sha256=9c849abdd1c2bd341a31f68505294a2b6dfc86b1c4e818a7f8eb7137aa38bae6",
        identity: "session-continuation.ts#outputText[Parameter]@1",
        location: {
          file: "session-continuation.ts",
          line: 724,
          column: 21,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=session-continuation.ts%23addToolResult%5BParameter%5D%401|sha256=e68ca2eb5c43ba2f757e4b5b9ce95d31b6f6419cfb6af35c9235cc853e2817e4",
        identity: "session-continuation.ts#addToolResult[Parameter]@1",
        location: {
          file: "session-continuation.ts",
          line: 817,
          column: 51,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=session-continuation.ts%23addOrphanResult%5BParameter%5D%401|sha256=95f5eb11690d62723449ff17d7d34653fbfca1631a7dad80403b8c8ab320e726",
        identity: "session-continuation.ts#addOrphanResult[Parameter]@1",
        location: {
          file: "session-continuation.ts",
          line: 823,
          column: 48,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=session-continuation.ts%23takeMatchingActivity%5BParameter%5D%401|sha256=5a72530a51336dbf05cdb136ff25cf4014b688837b28fc1bbce25e2808bbd6c4",
        identity: "session-continuation.ts#takeMatchingActivity[Parameter]@1",
        location: {
          file: "session-continuation.ts",
          line: 866,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=session-continuation.ts%23takeMatchingActivity%5BParameter%5D%401|sha256=f2724cc6e4e5e1497ba6ca6ee31743ab2f23e3bfe72bbe5e9222972e6953726f",
        identity: "session-continuation.ts#takeMatchingActivity[Parameter]@1",
        location: {
          file: "session-continuation.ts",
          line: 867,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=session-continuation.ts%23applyAdjacentToolPart%5BParameter%5D%401|sha256=a075c0757ea01a6d1d37c38d22b81187cea7df9777cdafd8f646053f5517bc56",
        identity: "session-continuation.ts#applyAdjacentToolPart[Parameter]@1",
        location: {
          file: "session-continuation.ts",
          line: 916,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=transient-model-retry.ts%23readNumber%5BParameter%5D%401|sha256=c94c2a4e955978a14b26c3612ca62bb7bdd0057290d4157af20d28b5afa24ae6",
        identity: "transient-model-retry.ts#readNumber[Parameter]@1",
        location: {
          file: "transient-model-retry.ts",
          line: 26,
          column: 21,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=transient-model-retry.ts%23hasRetryErrorExhausted%5BParameter%5D%401|sha256=4ea0ed660b681c718a5815251832dd3f0d1da361df15f4b90e60596571333c09",
        identity: "transient-model-retry.ts#hasRetryErrorExhausted[Parameter]@1",
        location: {
          file: "transient-model-retry.ts",
          line: 32,
          column: 33,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=transient-model-retry.ts%23hasTransientRetryErrorExhausted%5BParameter%5D%401|sha256=0bdcfee22a1bc3c647d8edd685b180599e8db99e961afef922569a29a2b2de37",
        identity: "transient-model-retry.ts#hasTransientRetryErrorExhausted[Parameter]@1",
        location: {
          file: "transient-model-retry.ts",
          line: 37,
          column: 42,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=transient-model-retry.ts%23hasTransientModelErrorHint%5BParameter%5D%401|sha256=6b9a8b54a0488e10522ce1ae85f24223b5bfde76d79da0a17b8434cacab41bca",
        identity: "transient-model-retry.ts#hasTransientModelErrorHint[Parameter]@1",
        location: {
          file: "transient-model-retry.ts",
          line: 42,
          column: 37,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=transient-model-retry.ts%23isRetryableTransientModelError%5BParameter%5D%401|sha256=571e05735f5fb33c717e0113949df632dafd86a76565cbee303ccbe5483c3971",
        identity: "transient-model-retry.ts#isRetryableTransientModelError[Parameter]@1",
        location: {
          file: "transient-model-retry.ts",
          line: 100,
          column: 48,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=transient-model-retry.ts%23defaultErrorSummary%5BParameter%5D%401|sha256=435111e47040dada294e13c7703341fe8771fafa447ac6f87205193477c05fba",
        identity: "transient-model-retry.ts#defaultErrorSummary[Parameter]@1",
        location: {
          file: "transient-model-retry.ts",
          line: 114,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=transient-model-retry.ts%23createTransientModelRetryController%5BParameter%5D%401|sha256=bee9d7298a621fc71935bddc1dba83240bdca2790699749fb7b7f668a92fc47f",
        identity: "transient-model-retry.ts#createTransientModelRetryController[Parameter]@1",
        location: {
          file: "transient-model-retry.ts",
          line: 130,
          column: 18,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-domain-unknown|identity=transient-model-retry.ts%23createTransientModelRetryController.handler%5BParameter%5D%401|sha256=0a93d6f39a17f2d2784e7e2a6bfc3d4210091481bd5eed4f4e3cc742eb31eb11",
        identity:
          "transient-model-retry.ts#createTransientModelRetryController.handler[Parameter]@1",
        location: {
          file: "transient-model-retry.ts",
          line: 141,
          column: 21,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
    ],
    "architecture/no-rich-unknown-predicate": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-rich-unknown-predicate|identity=tool-call-expansion.ts%23isToolExpansion%5BFunctionDeclaration%5D%401|sha256=92a50ce4e5a5a7c4960a3ad797954331919a5469f10b5d9572b63a6227ca7f9a",
        identity: "tool-call-expansion.ts#isToolExpansion[FunctionDeclaration]@1",
        location: {
          file: "tool-call-expansion.ts",
          line: 20,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-rich-unknown-predicate|identity=atomic-tool-execution.ts%23isAsyncIterable%5BFunctionDeclaration%5D%401|sha256=884a1bd04c4f849a733d44581e601e33457d105fc1db956649f79003825abcb2",
        identity: "atomic-tool-execution.ts#isAsyncIterable[FunctionDeclaration]@1",
        location: {
          file: "atomic-tool-execution.ts",
          line: 103,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-rich-unknown-predicate|identity=atomic-tool-execution.ts%23isJsonToolOutputValue%5BFunctionDeclaration%5D%401|sha256=f4f884d56fc29b44a9bce5c745121c5e1ac94e845802c97d3578bc1363eda7f7",
        identity: "atomic-tool-execution.ts#isJsonToolOutputValue[FunctionDeclaration]@1",
        location: {
          file: "atomic-tool-execution.ts",
          line: 119,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-rich-unknown-predicate|identity=atomic-tool-execution.ts%23isJsonToolOutputValueInner%5BFunctionDeclaration%5D%401|sha256=b33bfbac982ed34950f2b08c9f1291f54d38f560d0601ab4a859984f48115f85",
        identity: "atomic-tool-execution.ts#isJsonToolOutputValueInner[FunctionDeclaration]@1",
        location: {
          file: "atomic-tool-execution.ts",
          line: 123,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-rich-unknown-predicate|identity=ai-sdk-pi-agent.ts%23isClonedModelMessage%5BFunctionDeclaration%5D%401|sha256=dac9164aab7a8829aa08df3d66ad546ba6f5036113312a5c5205d91582ad23e2",
        identity: "ai-sdk-pi-agent.ts#isClonedModelMessage[FunctionDeclaration]@1",
        location: {
          file: "ai-sdk-pi-agent.ts",
          line: 633,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
    ],
    "architecture/no-unregistered-decoder": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-unregistered-decoder|identity=openai-server-compaction.ts%23readOpenAIServerCompactionArtifact%5BCallExpression%5D%401|sha256=2f57a59660fa9ddf94e26d5461044946f354d5188c0683a62ee957973175b668",
        identity:
          "openai-server-compaction.ts#readOpenAIServerCompactionArtifact[CallExpression]@1",
        location: {
          file: "openai-server-compaction.ts",
          line: 143,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-unregistered-decoder|identity=openai-server-compaction.ts%23compactWithOpenAIResponses.%3Ccallback%3E.%3Ccallback%3E%5BCallExpression%5D%401|sha256=31cfe461e916abb99b7c8cf862122df3747fabb172c92e31905153d8efcfdafa",
        identity:
          "openai-server-compaction.ts#compactWithOpenAIResponses.<callback>.<callback>[CallExpression]@1",
        location: {
          file: "openai-server-compaction.ts",
          line: 248,
          column: 26,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-unregistered-decoder|identity=openai-server-compaction.ts%23compactWithOpenAIResponses%5BCallExpression%5D%401|sha256=7a3638c81f7f5cd672ac315391b03584ec0679d6cbf9d3cd592bccee456e9b41",
        identity: "openai-server-compaction.ts#compactWithOpenAIResponses[CallExpression]@1",
        location: {
          file: "openai-server-compaction.ts",
          line: 273,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-unregistered-decoder|identity=session-continuation.ts%23parseStrictJsonValue%5BCallExpression%5D%401|sha256=a6b1ccca17fec6c4c6338bd0608020a112053f76ea19d124e154db94a8477afd",
        identity: "session-continuation.ts#parseStrictJsonValue[CallExpression]@1",
        location: {
          file: "session-continuation.ts",
          line: 227,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-unregistered-decoder|identity=session-continuation.ts%23hashExecutionScopeV1%5BCallExpression%5D%401|sha256=f3eb2640470f51bf29e3beaec416ecc56865def3004f88d25c02c577001154c8",
        identity: "session-continuation.ts#hashExecutionScopeV1[CallExpression]@1",
        location: {
          file: "session-continuation.ts",
          line: 545,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fagent|rule=architecture%2Fno-unregistered-decoder|identity=session-continuation.ts%23preparePlainTextReplayForTarget%5BCallExpression%5D%401|sha256=e647b37eca115338d4c9853a90819be070b291791b759e28e381c8824577f9b6",
        identity: "session-continuation.ts#preparePlainTextReplayForTarget[CallExpression]@1",
        location: {
          file: "session-continuation.ts",
          line: 1042,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
    ],
  },
  "packages/claude-code-bridge": {
    "architecture/no-domain-unknown": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fclaude-code-bridge|rule=architecture%2Fno-domain-unknown|identity=claude-code-tools.ts%23stringifyJson%5BParameter%5D%401|sha256=c2770c2b59ac4d2818b2c57ca29a5c253e5aa943a6db9fddbdb10312401da6fe",
        identity: "claude-code-tools.ts#stringifyJson[Parameter]@1",
        location: {
          file: "claude-code-tools.ts",
          line: 84,
          column: 24,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fclaude-code-bridge|rule=architecture%2Fno-domain-unknown|identity=claude-code-run.ts%23boundedText%5BParameter%5D%401|sha256=188f9c9f86055a12b110a2bcc6cf0f9ddcc433028703ffc8c4debebdd07e09b0",
        identity: "claude-code-run.ts#boundedText[Parameter]@1",
        location: {
          file: "claude-code-run.ts",
          line: 230,
          column: 22,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fclaude-code-bridge|rule=architecture%2Fno-domain-unknown|identity=claude-code-run.ts%23waitForProcessExitProof.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%401|sha256=449bbf041cf3b389546f84dc5a191cdd235211fd66aeafaeeac59fa8ecd93e2b",
        identity: "claude-code-run.ts#waitForProcessExitProof.<callback>.<callback>[Parameter]@1",
        location: {
          file: "claude-code-run.ts",
          line: 262,
          column: 8,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fclaude-code-bridge|rule=architecture%2Fno-domain-unknown|identity=claude-code-run.ts%23materializeClaudeCodeRun%5BParameter%5D%401|sha256=8a8bd9807799da8a08c1478031c6a036dd1627a806be452f29ce332ea3c85bcb",
        identity: "claude-code-run.ts#materializeClaudeCodeRun[Parameter]@1",
        location: {
          file: "claude-code-run.ts",
          line: 371,
          column: 19,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fclaude-code-bridge|rule=architecture%2Fno-domain-unknown|identity=claude-code-run.ts%23materializeClaudeCodeRun.recordCallbackError%5BParameter%5D%401|sha256=3e8dad252c0ff9d9ab7250fde9345c5746850e3d8f9c1e94a4d6b4f918f740da",
        identity: "claude-code-run.ts#materializeClaudeCodeRun.recordCallbackError[Parameter]@1",
        location: {
          file: "claude-code-run.ts",
          line: 465,
          column: 32,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fclaude-code-bridge|rule=architecture%2Fno-domain-unknown|identity=claude-code-run.ts%23materializeClaudeCodeRun.beginContextCapture.%3Ccallback%3E%5BParameter%5D%401|sha256=7270f5eea334d48ec4947e6f017d5c4b59fa99b7cd3bf7dcad56f38b43f04f47",
        identity:
          "claude-code-run.ts#materializeClaudeCodeRun.beginContextCapture.<callback>[Parameter]@1",
        location: {
          file: "claude-code-run.ts",
          line: 516,
          column: 14,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fclaude-code-bridge|rule=architecture%2Fno-domain-unknown|identity=claude-code-run.ts%23materializeClaudeCodeRun.beginContextCapture.%3Ccallback%3E%5BParameter%5D%401|sha256=d43eee2675868ac3d7292d422ec648a157c6bc5b3b7205a5448a2f4eb324b91b",
        identity:
          "claude-code-run.ts#materializeClaudeCodeRun.beginContextCapture.<callback>[Parameter]@1",
        location: {
          file: "claude-code-run.ts",
          line: 528,
          column: 15,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fclaude-code-bridge|rule=architecture%2Fno-domain-unknown|identity=claude-code-run.ts%23materializeClaudeCodeRun.observeSdkMessage%5BParameter%5D%401|sha256=7ead810d0259b760d4955257a31859849f9c91bb7be8aeea663db11561cc5a9d",
        identity: "claude-code-run.ts#materializeClaudeCodeRun.observeSdkMessage[Parameter]@1",
        location: {
          file: "claude-code-run.ts",
          line: 532,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fclaude-code-bridge|rule=architecture%2Fno-domain-unknown|identity=claude-attempt-runtime-owner.ts%23ClaudeAttemptRuntimeOwner.materializeCandidate.%3Ccallback%3E%5BParameter%5D%401|sha256=057f6ba2740f6b26ee0aec3c368185cfbfd1be725ec45f0b0ab7f84781711029",
        identity:
          "claude-attempt-runtime-owner.ts#ClaudeAttemptRuntimeOwner.materializeCandidate.<callback>[Parameter]@1",
        location: {
          file: "claude-attempt-runtime-owner.ts",
          line: 410,
          column: 15,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
    ],
    "architecture/no-unregistered-decoder": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fclaude-code-bridge|rule=architecture%2Fno-unregistered-decoder|identity=claude-code-tools.ts%23createClaudeCodeToolBridge%5BCallExpression%5D%401|sha256=75c3037273227a2505eae8db4ccd6533b18d576cf0fc35a962ee32053c2b91fa",
        identity: "claude-code-tools.ts#createClaudeCodeToolBridge[CallExpression]@1",
        location: {
          file: "claude-code-tools.ts",
          line: 362,
          column: 9,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fclaude-code-bridge|rule=architecture%2Fno-unregistered-decoder|identity=claude-code-run.ts%23readSessionInfo%5BCallExpression%5D%401|sha256=eac08b969e63d454c1b2b7d774b3fc89c33af48e035562d534b0bc7a3ff9453b",
        identity: "claude-code-run.ts#readSessionInfo[CallExpression]@1",
        location: {
          file: "claude-code-run.ts",
          line: 325,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fclaude-code-bridge|rule=architecture%2Fno-unregistered-decoder|identity=claude-code-run.ts%23materializeClaudeCodeRun%5BCallExpression%5D%401|sha256=90e63a4ef8e3a6f7ce86a1970b713252cbc93bf402a761a6c39649801565dafa",
        identity: "claude-code-run.ts#materializeClaudeCodeRun[CallExpression]@1",
        location: {
          file: "claude-code-run.ts",
          line: 373,
          column: 17,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fclaude-code-bridge|rule=architecture%2Fno-unregistered-decoder|identity=claude-code-run.ts%23materializeClaudeCodeRun.beginContextCapture.%3Ccallback%3E%5BCallExpression%5D%401|sha256=3bb01668dc596ff07c54bb0db8a3125e536ed32b67ce2b5722dca2a0eefc1fda",
        identity:
          "claude-code-run.ts#materializeClaudeCodeRun.beginContextCapture.<callback>[CallExpression]@1",
        location: {
          file: "claude-code-run.ts",
          line: 517,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fclaude-code-bridge|rule=architecture%2Fno-unregistered-decoder|identity=claude-code-run.ts%23materializeClaudeCodeRun.observeSdkMessage%5BCallExpression%5D%401|sha256=bede896dfd2de68ee206a0bdfe99074eecfd87fce0758a6e996d8028b747362b",
        identity: "claude-code-run.ts#materializeClaudeCodeRun.observeSdkMessage[CallExpression]@1",
        location: {
          file: "claude-code-run.ts",
          line: 534,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fclaude-code-bridge|rule=architecture%2Fno-unregistered-decoder|identity=claude-code-run.ts%23materializeClaudeCodeRun.observeSdkMessage%5BCallExpression%5D%401|sha256=5e2cd0850b0cbe27a9fac75b53c6186b3521948beb96909a9d830b0f38071d9a",
        identity: "claude-code-run.ts#materializeClaudeCodeRun.observeSdkMessage[CallExpression]@1",
        location: {
          file: "claude-code-run.ts",
          line: 538,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fclaude-code-bridge|rule=architecture%2Fno-unregistered-decoder|identity=claude-code-run.ts%23materializeClaudeCodeRun.observeSdkMessage%5BCallExpression%5D%401|sha256=1512053bee1ae22f5d8b2a54bbc0f49ad1913459d02838e5e8cc286cd847f095",
        identity: "claude-code-run.ts#materializeClaudeCodeRun.observeSdkMessage[CallExpression]@1",
        location: {
          file: "claude-code-run.ts",
          line: 555,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fclaude-code-bridge|rule=architecture%2Fno-unregistered-decoder|identity=claude-code-run.ts%23materializeClaudeCodeRun.stopHook%5BCallExpression%5D%401|sha256=1c7eb1b561f6ad34efa4be10dcca78d714800b6f20b89ac8e2e8893c83a1b734",
        identity: "claude-code-run.ts#materializeClaudeCodeRun.stopHook[CallExpression]@1",
        location: {
          file: "claude-code-run.ts",
          line: 589,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fclaude-code-bridge|rule=architecture%2Fno-unregistered-decoder|identity=claude-attempt-runtime-owner.ts%23ClaudeAttemptRuntimeOwner.recordSuccessfulModelCall%5BCallExpression%5D%401|sha256=75991bda1f595f995b72a266fdce9a7df6e1a4681f71ff72a1159a1fc57ef12a",
        identity:
          "claude-attempt-runtime-owner.ts#ClaudeAttemptRuntimeOwner.recordSuccessfulModelCall[CallExpression]@1",
        location: {
          file: "claude-attempt-runtime-owner.ts",
          line: 164,
          column: 25,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fclaude-code-bridge|rule=architecture%2Fno-unregistered-decoder|identity=claude-attempt-runtime-owner.ts%23ClaudeAttemptRuntimeOwner.materializeCandidate.%3Ccallback%3E%5BCallExpression%5D%401|sha256=27b61d8579a1f3de1cb304f4bb396fa332a0209d577c9d687d4043e88bea0056",
        identity:
          "claude-attempt-runtime-owner.ts#ClaudeAttemptRuntimeOwner.materializeCandidate.<callback>[CallExpression]@1",
        location: {
          file: "claude-attempt-runtime-owner.ts",
          line: 341,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
    ],
  },
  "packages/coding-tools": {
    "architecture/no-domain-unknown": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fcoding-tools|rule=architecture%2Fno-domain-unknown|identity=src%2Fguardrails.ts%23getErrorCode%5BParameter%5D%401|sha256=b95a7fcb6752669d41ad9f334cc9c8a89d4284706dd8a9b30b008d2836507a13",
        identity: "src/guardrails.ts#getErrorCode[Parameter]@1",
        location: {
          file: "src/guardrails.ts",
          line: 25,
          column: 23,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fcoding-tools|rule=architecture%2Fno-domain-unknown|identity=src%2Fbash.ts%23streamLocalBash.%3Ccallback%3E%5BParameter%5D%401|sha256=c61bcb2c59d40d2ed9d5dfc759c4fd7e12c584072a9071ef022bb49d3d1ff5a4",
        identity: "src/bash.ts#streamLocalBash.<callback>[Parameter]@1",
        location: {
          file: "src/bash.ts",
          line: 746,
          column: 6,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fcoding-tools|rule=architecture%2Fno-domain-unknown|identity=src%2Fbatch.ts%23%3Cmodule%3E%5BParameter%5D%401|sha256=e86ec637e1de928b26321091d01f498a9e0c36f2196fed076e72063af15ec208",
        identity: "src/batch.ts#<module>[Parameter]@1",
        location: {
          file: "src/batch.ts",
          line: 33,
          column: 5,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fcoding-tools|rule=architecture%2Fno-domain-unknown|identity=src%2Fbatch.ts%23hasParseAsync%5BParameter%5D%401|sha256=d3ca15e6f5ab3134205f85819b8a9a98377b834354969d1c48fb444d5a90d66f",
        identity: "src/batch.ts#hasParseAsync[Parameter]@1",
        location: {
          file: "src/batch.ts",
          line: 55,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fcoding-tools|rule=architecture%2Fno-domain-unknown|identity=src%2Fbatch.ts%23hasParseAsync%5BParameter%5D%401|sha256=08f836e801a66bdca2a20d9bb5dae958e2cb9d9aa03537ad9f44e3179a274478",
        identity: "src/batch.ts#hasParseAsync[Parameter]@1",
        location: {
          file: "src/batch.ts",
          line: 56,
          column: 27,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fcoding-tools|rule=architecture%2Fno-domain-unknown|identity=src%2Fbatch.ts%23hasParse%5BParameter%5D%401|sha256=92cd0c7aebf6b5943752c9ef57eaf959def032f7c8ea66a46c1447dbfb0d1996",
        identity: "src/batch.ts#hasParse[Parameter]@1",
        location: {
          file: "src/batch.ts",
          line: 65,
          column: 19,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fcoding-tools|rule=architecture%2Fno-domain-unknown|identity=src%2Fbatch.ts%23hasParse%5BParameter%5D%401|sha256=95ca42e12e743c4dd4f4231b8e8fa7b10d55912c5d926de7965545b3cf4f4670",
        identity: "src/batch.ts#hasParse[Parameter]@1",
        location: {
          file: "src/batch.ts",
          line: 65,
          column: 55,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fcoding-tools|rule=architecture%2Fno-domain-unknown|identity=src%2Fbatch.ts%23validateInput%5BParameter%5D%401|sha256=768664921ea01879fc372b8630265f504a916c4db9dbb0ff4be31ba568c0661d",
        identity: "src/batch.ts#validateInput[Parameter]@1",
        location: {
          file: "src/batch.ts",
          line: 74,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fcoding-tools|rule=architecture%2Fno-domain-unknown|identity=src%2Fbatch.ts%23validateInput%5BParameter%5D%401|sha256=38c59e4f147047127a5434047b607c8523f9f275626edee86c285b8bb6d834d7",
        identity: "src/batch.ts#validateInput[Parameter]@1",
        location: {
          file: "src/batch.ts",
          line: 74,
          column: 51,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fcoding-tools|rule=architecture%2Fno-domain-unknown|identity=src%2Ffilesystem.ts%23isReadFileAttachmentOutput%5BParameter%5D%401|sha256=f0bd19d78d92d9e8443a10b1f74308590da2115080cfdfc4761a1ebe0cd8ddaf",
        identity: "src/filesystem.ts#isReadFileAttachmentOutput[Parameter]@1",
        location: {
          file: "src/filesystem.ts",
          line: 52,
          column: 37,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
    ],
    "architecture/no-rich-unknown-predicate": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fcoding-tools|rule=architecture%2Fno-rich-unknown-predicate|identity=src%2Fbatch.ts%23hasParseAsync%5BFunctionDeclaration%5D%401|sha256=9f366c0b04d89f7d28c7802b3af4f8d1ba68cf8dbf8293ca211eca0b794780f9",
        identity: "src/batch.ts#hasParseAsync[FunctionDeclaration]@1",
        location: {
          file: "src/batch.ts",
          line: 54,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fcoding-tools|rule=architecture%2Fno-rich-unknown-predicate|identity=src%2Fbatch.ts%23hasParse%5BFunctionDeclaration%5D%401|sha256=21436b997d1d93f94750abf371f2b6f1b84755f7e28b25fd2e403a8d4162d5eb",
        identity: "src/batch.ts#hasParse[FunctionDeclaration]@1",
        location: {
          file: "src/batch.ts",
          line: 65,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fcoding-tools|rule=architecture%2Fno-rich-unknown-predicate|identity=src%2Ffilesystem.ts%23isReadFileAttachmentOutput%5BFunctionDeclaration%5D%401|sha256=6ac242e74404ba5fa6cf1a32da89822a9c3834025f9648be3a2f2d80bd7b6532",
        identity: "src/filesystem.ts#isReadFileAttachmentOutput[FunctionDeclaration]@1",
        location: {
          file: "src/filesystem.ts",
          line: 52,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
    ],
    "architecture/no-unknown-assertion": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fcoding-tools|rule=architecture%2Fno-unknown-assertion|identity=src%2Fbatch.ts%23validateInput%5BAsExpression%5D%401|sha256=1a23d80ea0d8d05d72e4b82e9f34469648f084925f0a541633846ca9ed9231f6",
        identity: "src/batch.ts#validateInput[AsExpression]@1",
        location: {
          file: "src/batch.ts",
          line: 77,
          column: 27,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
    ],
    "architecture/no-unregistered-decoder": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fcoding-tools|rule=architecture%2Fno-unregistered-decoder|identity=src%2Finstructions.ts%23collectPreviouslyLoadedInstructionPaths%5BCallExpression%5D%401|sha256=6501ec9b630b098f0a8100159784794c4e76a46dba655d25a87d49360c173211",
        identity: "src/instructions.ts#collectPreviouslyLoadedInstructionPaths[CallExpression]@1",
        location: {
          file: "src/instructions.ts",
          line: 158,
          column: 27,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fcoding-tools|rule=architecture%2Fno-unregistered-decoder|identity=src%2Finstructions.ts%23collectPreviouslyLoadedInstructionPaths%5BCallExpression%5D%401|sha256=e3b9f78a1965efcbdbe735455a9e4c7f0db3efa200c3cfe8b98747071cfab3d4",
        identity: "src/instructions.ts#collectPreviouslyLoadedInstructionPaths[CallExpression]@1",
        location: {
          file: "src/instructions.ts",
          line: 162,
          column: 26,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fcoding-tools|rule=architecture%2Fno-unregistered-decoder|identity=src%2Finstructions.ts%23collectPreviouslyLoadedInstructionPaths%5BCallExpression%5D%401|sha256=9c3a4d64978c0da5b98cebb4518f24d355e1ac0495c676574d8e57b03268b9af",
        identity: "src/instructions.ts#collectPreviouslyLoadedInstructionPaths[CallExpression]@1",
        location: {
          file: "src/instructions.ts",
          line: 165,
          column: 26,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fcoding-tools|rule=architecture%2Fno-unregistered-decoder|identity=src%2Finstructions.ts%23collectPreviouslyLoadedInstructionPaths%5BCallExpression%5D%401|sha256=6ebdd5709c872d5a6f852ab695fa76a93ade6a66fd2f513ec9e7b544f376ff5b",
        identity: "src/instructions.ts#collectPreviouslyLoadedInstructionPaths[CallExpression]@1",
        location: {
          file: "src/instructions.ts",
          line: 178,
          column: 29,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fcoding-tools|rule=architecture%2Fno-unregistered-decoder|identity=src%2Finstructions.ts%23collectPreviouslyLoadedInstructionPaths%5BCallExpression%5D%401|sha256=23f3fa50aeda5250c4d8e51402b6f7ab3a62667f30d06595b70c2e7a2f0c4fe8",
        identity: "src/instructions.ts#collectPreviouslyLoadedInstructionPaths[CallExpression]@1",
        location: {
          file: "src/instructions.ts",
          line: 181,
          column: 26,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fcoding-tools|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ffilesystem.ts%23createFilesystemTools.toModelOutput%5BCallExpression%5D%401|sha256=4b25d6b594860c53f63cde0ff5293215847596da0a02a56ec44df44fc8de6b36",
        identity: "src/filesystem.ts#createFilesystemTools.toModelOutput[CallExpression]@1",
        location: {
          file: "src/filesystem.ts",
          line: 258,
          column: 13,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fcoding-tools|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ffilesystem.ts%23createFilesystemTools.toModelOutput%5BCallExpression%5D%401|sha256=b70c30e00f7994d32bb470065e2455a3ece00f869530d885047f4bd66f0a3785",
        identity: "src/filesystem.ts#createFilesystemTools.toModelOutput[CallExpression]@1",
        location: {
          file: "src/filesystem.ts",
          line: 300,
          column: 9,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fcoding-tools|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ffilesystem.ts%23createFilesystemTools.toModelOutput%5BCallExpression%5D%402|sha256=30d36a5292853921aa016cf507d28b461be537df1e6339675841c1d1e7fdba85",
        identity: "src/filesystem.ts#createFilesystemTools.toModelOutput[CallExpression]@2",
        location: {
          file: "src/filesystem.ts",
          line: 313,
          column: 9,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fcoding-tools|rule=architecture%2Fno-unregistered-decoder|identity=src%2Ffilesystem.ts%23createFilesystemTools.toModelOutput%5BCallExpression%5D%403|sha256=18bc66166dad4ed88ea90cefffa086178dde43db62c4532df39f3e80385442c5",
        identity: "src/filesystem.ts#createFilesystemTools.toModelOutput[CallExpression]@3",
        location: {
          file: "src/filesystem.ts",
          line: 358,
          column: 9,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
    ],
  },
  "packages/event-bus": {
    "architecture/no-domain-unknown": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fevent-bus|rule=architecture%2Fno-domain-unknown|identity=core-primary-lineage.ts%23canonicalizeCoreLineageAtomV1%5BParameter%5D%401|sha256=4795cc4678d33c5f3c57b0710471d5ad6fe46d03c2a3c99aba57d5af2672c1e7",
        identity: "core-primary-lineage.ts#canonicalizeCoreLineageAtomV1[Parameter]@1",
        location: {
          file: "core-primary-lineage.ts",
          line: 136,
          column: 47,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fevent-bus|rule=architecture%2Fno-domain-unknown|identity=core-primary-lineage.ts%23parseCorePrimaryLineageV1%5BParameter%5D%401|sha256=1975e5b8b0904d452621e5af5ac62b52103d0be5524909ee8e8826ce4721e5ce",
        identity: "core-primary-lineage.ts#parseCorePrimaryLineageV1[Parameter]@1",
        location: {
          file: "core-primary-lineage.ts",
          line: 341,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fevent-bus|rule=architecture%2Fno-domain-unknown|identity=core-primary-lineage.ts%23parseCorePrimaryLineageV1%5BParameter%5D%401|sha256=6e83b8bba010a82e3eaa04add8bfa961790c7caef5991cd245e88a396b92e1b2",
        identity: "core-primary-lineage.ts#parseCorePrimaryLineageV1[Parameter]@1",
        location: {
          file: "core-primary-lineage.ts",
          line: 342,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fevent-bus|rule=architecture%2Fno-domain-unknown|identity=redis-streams-bus.ts%23toRecord%5BParameter%5D%401|sha256=18c3af71c86371fe9d0f860a2a6e656ddb0341d63bc31febe2ffd5448ca56eea",
        identity: "redis-streams-bus.ts#toRecord[Parameter]@1",
        location: {
          file: "redis-streams-bus.ts",
          line: 149,
          column: 19,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fevent-bus|rule=architecture%2Fno-domain-unknown|identity=redis-streams-bus.ts%23decodeMessage%5BParameter%5D%401|sha256=6a187dc496d2055b54ac9c825a4c44c24d81c4f20516fe5c3e47d202095c7469",
        identity: "redis-streams-bus.ts#decodeMessage[Parameter]@1",
        location: {
          file: "redis-streams-bus.ts",
          line: 172,
          column: 50,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fevent-bus|rule=architecture%2Fno-domain-unknown|identity=redis-streams-bus.ts%23RedisStreamsBus.startAcknowledgedTrim.%3Ccallback%3E%5BParameter%5D%401|sha256=2808c6dad864330d3ba1d2b2715780412db481e70792d6f08a53e2ea6cbfe5ec",
        identity:
          "redis-streams-bus.ts#RedisStreamsBus.startAcknowledgedTrim.<callback>[Parameter]@1",
        location: {
          file: "redis-streams-bus.ts",
          line: 369,
          column: 77,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fevent-bus|rule=architecture%2Fno-domain-unknown|identity=lilac-spec.ts%23parseCmdRequestMessageData%5BParameter%5D%401|sha256=eaa61175b3eec488c21f77984ce43eaaf9ceb70c44d3dca1650bcce7f22fc6f7",
        identity: "lilac-spec.ts#parseCmdRequestMessageData[Parameter]@1",
        location: {
          file: "lilac-spec.ts",
          line: 122,
          column: 44,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
    ],
    "architecture/no-unregistered-decoder": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fevent-bus|rule=architecture%2Fno-unregistered-decoder|identity=core-primary-lineage.ts%23canonicalizeCoreLineageAtomV1%5BCallExpression%5D%401|sha256=3ec39c074f82191d059782f64d47b4ab070715428cb0e1a9e6d8ea2004bbc550",
        identity: "core-primary-lineage.ts#canonicalizeCoreLineageAtomV1[CallExpression]@1",
        location: {
          file: "core-primary-lineage.ts",
          line: 137,
          column: 16,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fevent-bus|rule=architecture%2Fno-unregistered-decoder|identity=core-primary-lineage.ts%23buildCoreLineageManifestV1%5BCallExpression%5D%401|sha256=4b212aa99bfa9f14c4797df14bfae51eef16d42be3b760773ed825655db86cd6",
        identity: "core-primary-lineage.ts#buildCoreLineageManifestV1[CallExpression]@1",
        location: {
          file: "core-primary-lineage.ts",
          line: 311,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fevent-bus|rule=architecture%2Fno-unregistered-decoder|identity=core-primary-lineage.ts%23parseCorePrimaryLineageV1%5BCallExpression%5D%401|sha256=abf57e9021120810dcf35b6061a315ab7d773b843a17c555c78ad25af4bcf0e9",
        identity: "core-primary-lineage.ts#parseCorePrimaryLineageV1[CallExpression]@1",
        location: {
          file: "core-primary-lineage.ts",
          line: 344,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fevent-bus|rule=architecture%2Fno-unregistered-decoder|identity=core-primary-lineage.ts%23parseCorePrimaryLineageV1%5BCallExpression%5D%401|sha256=511952b4189eedce1213d5126c6497ded8d0b8b19a13cec7a06b57942cf829a6",
        identity: "core-primary-lineage.ts#parseCorePrimaryLineageV1[CallExpression]@1",
        location: {
          file: "core-primary-lineage.ts",
          line: 345,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fevent-bus|rule=architecture%2Fno-unregistered-decoder|identity=core-primary-lineage.ts%23createCorePrimaryLineageFreshOnlyV1%5BCallExpression%5D%401|sha256=a438e39938b4a327d525c9c4d614bab00f27061b7c32bdb122a380f56ddbbc5f",
        identity: "core-primary-lineage.ts#createCorePrimaryLineageFreshOnlyV1[CallExpression]@1",
        location: {
          file: "core-primary-lineage.ts",
          line: 361,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fevent-bus|rule=architecture%2Fno-unregistered-decoder|identity=lilac-spec.ts%23parseCmdRequestMessageData%5BCallExpression%5D%401|sha256=ab2f626c33116aef74ff93a5ae0106b754c03266ca4b96765ee3ccc9b2477ad9",
        identity: "lilac-spec.ts#parseCmdRequestMessageData[CallExpression]@1",
        location: {
          file: "lilac-spec.ts",
          line: 123,
          column: 16,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
    ],
    "architecture/no-unknown-assertion": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fevent-bus|rule=architecture%2Fno-unknown-assertion|identity=lilac-bus.ts%23createLilacBus.subscribeType%5BAsExpression%5D%401|sha256=b1f5f2549b900d2c3c32634cf935b6624bd2018d82714c24410d1b6a6502845e",
        identity: "lilac-bus.ts#createLilacBus.subscribeType[AsExpression]@1",
        location: {
          file: "lilac-bus.ts",
          line: 323,
          column: 12,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fevent-bus|rule=architecture%2Fno-unknown-assertion|identity=lilac-bus.ts%23createLilacBus.fetchTopic%5BAsExpression%5D%401|sha256=de7f6d1c1bd7479c1bddeaec2be66f863f3c8d78ef444d205230b14d91f50f0d",
        identity: "lilac-bus.ts#createLilacBus.fetchTopic[AsExpression]@1",
        location: {
          file: "lilac-bus.ts",
          line: 341,
          column: 19,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
    ],
  },
  "packages/fs": {
    "architecture/no-domain-unknown": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Ffs|rule=architecture%2Fno-domain-unknown|identity=src%2Fripgrep.ts%23parseMatchEvent%5BParameter%5D%401|sha256=ec2b2920bdb2411cf2020c97259c232c6bdc96b19deff91501ab6f60593a4554",
        identity: "src/ripgrep.ts#parseMatchEvent[Parameter]@1",
        location: {
          file: "src/ripgrep.ts",
          line: 80,
          column: 26,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Ffs|rule=architecture%2Fno-domain-unknown|identity=src%2Ffs-impl.ts%23getErrorCode%5BParameter%5D%401|sha256=019dd64fde8c6a066a37a4a81f631a67a207827b9489f6c559c322ef42e1c326",
        identity: "src/fs-impl.ts#getErrorCode[Parameter]@1",
        location: {
          file: "src/fs-impl.ts",
          line: 41,
          column: 23,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Ffs|rule=architecture%2Fno-domain-unknown|identity=src%2Ffs-impl.ts%23isSkippableTraversalError%5BParameter%5D%401|sha256=e880dc1818188942db803c646912e019277b7e578e08fc022259e53e4a5d27b0",
        identity: "src/fs-impl.ts#isSkippableTraversalError[Parameter]@1",
        location: {
          file: "src/fs-impl.ts",
          line: 47,
          column: 36,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
    ],
    "architecture/no-unregistered-decoder": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Ffs|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fripgrep.ts%23parseMatchEvent%5BCallExpression%5D%401|sha256=bbc3105cb0b389ef314f86eaed23d1dd286940115a493dd344f7a6347861d235",
        identity: "src/ripgrep.ts#parseMatchEvent[CallExpression]@1",
        location: {
          file: "src/ripgrep.ts",
          line: 81,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
    ],
  },
  "packages/mini-lilac-client": {
    "architecture/no-domain-unknown": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-domain-unknown|identity=protocol.ts%23%3Ccallback%3E%5BParameter%5D%401|sha256=168a0b91dbee466a4da2da26437ac74abc25257f6ef9e548a3537fb29cd797c9",
        identity: "protocol.ts#<callback>[Parameter]@1",
        location: {
          file: "protocol.ts",
          line: 611,
          column: 6,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-domain-unknown|identity=protocol.ts%23%3Ccallback%3E%5BParameter%5D%402|sha256=430d4a2ada3317bd0b2081f315a07fb5b624527ad574e0d7a9fd5c2a7e876c1d",
        identity: "protocol.ts#<callback>[Parameter]@2",
        location: {
          file: "protocol.ts",
          line: 617,
          column: 4,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
    ],
    "architecture/no-unregistered-decoder": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.constructor%5BCallExpression%5D%401|sha256=e502b3d48f55fc934f189aa670a61e5c651e4d17ba9c9a5c51dd7269700e76e5",
        identity: "mini-lilac-transport.ts#MiniLilacTransport.constructor[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 152,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.constructor.prepareSendMessagesRequest%5BCallExpression%5D%401|sha256=b111641041b79dd67f3cf47e0e87f0303c7d10ae35752916eaf4e0a5d49b25ba",
        identity:
          "mini-lilac-transport.ts#MiniLilacTransport.constructor.prepareSendMessagesRequest[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 165,
          column: 31,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.getSession%5BCallExpression%5D%401|sha256=5f35fea8501bb7cb07194fdce1bd3c9695bf172c1b82384c33d7d3873dd168f7",
        identity: "mini-lilac-transport.ts#MiniLilacTransport.getSession[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 222,
          column: 16,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.getSessionResume%5BCallExpression%5D%401|sha256=e191b929ced6ac3d96c9fa52d6925b9871aa0d0bb9831d141ac1a7770bf9b5f5",
        identity: "mini-lilac-transport.ts#MiniLilacTransport.getSessionResume[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 232,
          column: 16,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.listSessions%5BCallExpression%5D%401|sha256=e9c3c9d11525bcba412de0364a092565f3300f9a082daa8deccbef45e286bc31",
        identity: "mini-lilac-transport.ts#MiniLilacTransport.listSessions[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 255,
          column: 27,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.getMessages%5BCallExpression%5D%401|sha256=a39a9a2e2743b80aa7a84f357211674ec40df0ab9825c8b49056218e80fa42bb",
        identity: "mini-lilac-transport.ts#MiniLilacTransport.getMessages[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 267,
          column: 16,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.streamSession%5BCallExpression%5D%401|sha256=8a4fbe12ddc66f433aa61c7aff685df60cd7d33534b825442ae8fa2248cb5eb1",
        identity: "mini-lilac-transport.ts#MiniLilacTransport.streamSession[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 281,
          column: 33,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.getTodos%5BCallExpression%5D%401|sha256=7cfeea0d555483177cd5d26a50cb9cb5c4d2a45deaee51a23c166e28db478fe2",
        identity: "mini-lilac-transport.ts#MiniLilacTransport.getTodos[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 310,
          column: 16,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.listSkills%5BCallExpression%5D%401|sha256=9abbfde2bebbe76c34ff3946b806d199b5590d5b5933ea574b0055ac823a5082",
        identity: "mini-lilac-transport.ts#MiniLilacTransport.listSkills[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 329,
          column: 27,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.listSkills%5BCallExpression%5D%401|sha256=82512b4d2c6d579fc34b5dd3d2581253ad0747f3740433e0f1e48e7f04a2655b",
        identity: "mini-lilac-transport.ts#MiniLilacTransport.listSkills[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 331,
          column: 54,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.setSessionBindings%5BCallExpression%5D%401|sha256=0d7ea0a1c0f7ed21a198dbe69b94df6b7afcbdf8d1e234117fd9ebef8390b1fe",
        identity: "mini-lilac-transport.ts#MiniLilacTransport.setSessionBindings[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 342,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.steer%5BCallExpression%5D%401|sha256=1e000920f7e054839e7a8fffa6775330d63e3d98f8175bde4a23fbf210535dd3",
        identity: "mini-lilac-transport.ts#MiniLilacTransport.steer[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 367,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.interruptQueuedSteering%5BCallExpression%5D%401|sha256=9d76ec0831b7ca5ee35661e58233ac870dd11995014020475ce96a9b04acaf9c",
        identity:
          "mini-lilac-transport.ts#MiniLilacTransport.interruptQueuedSteering[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 384,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.cancel%5BCallExpression%5D%401|sha256=6b39bd3ab8aabd29e4b17354b23d1e333ff99da6d483d4416a4c951483e1687d",
        identity: "mini-lilac-transport.ts#MiniLilacTransport.cancel[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 401,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.undo%5BCallExpression%5D%401|sha256=312c9b9def11da8ab19e048eb6e191b511fffa5ea56ab9272318d17d1fa867b3",
        identity: "mini-lilac-transport.ts#MiniLilacTransport.undo[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 418,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.redo%5BCallExpression%5D%401|sha256=832850531210c48c66f7b0341de8f9f26a1d0feff975742f78ea4f48b560dfa0",
        identity: "mini-lilac-transport.ts#MiniLilacTransport.redo[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 429,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.cancelCompaction%5BCallExpression%5D%401|sha256=fa130359792c11738faf1a65781828e5eb456951db10fc80c4bc6ab2ab5308bb",
        identity: "mini-lilac-transport.ts#MiniLilacTransport.cancelCompaction[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 441,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.compact%5BCallExpression%5D%401|sha256=41db66c15fc01befe3b44294db3f902d596ca3faa67d103583b96a4f054675a8",
        identity: "mini-lilac-transport.ts#MiniLilacTransport.compact[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 465,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.compact%5BCallExpression%5D%401|sha256=cfaf7351edc44958745285308dbb5469730405c1419a51ccd9bbc69f3ec7bf79",
        identity: "mini-lilac-transport.ts#MiniLilacTransport.compact[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 481,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.compact%5BCallExpression%5D%401|sha256=6f0997e36efc3531fd02080b1c42f8475b3fbd18db670a7018a85efc52da67f9",
        identity: "mini-lilac-transport.ts#MiniLilacTransport.compact[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 483,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.compact%5BCallExpression%5D%401|sha256=d9b91117a0dde221508f97e2c108913a4e667810b3f0e1cc81f6e448ce04479f",
        identity: "mini-lilac-transport.ts#MiniLilacTransport.compact[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 505,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.performSessionBindingUpdate%5BCallExpression%5D%401|sha256=20f094959546faef769eb5f68d2632b932a5c67fb04b4a5790bf980a7c574490",
        identity:
          "mini-lilac-transport.ts#MiniLilacTransport.performSessionBindingUpdate[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 566,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.trackStream.transform%5BCallExpression%5D%401|sha256=4b9ba3496d0bcd8f7dde3341c45a9c8d935dd4a3c1b9e5eb1a40cbddcec99e40",
        identity:
          "mini-lilac-transport.ts#MiniLilacTransport.trackStream.transform[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 607,
          column: 26,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-client|rule=architecture%2Fno-unregistered-decoder|identity=mini-lilac-transport.ts%23MiniLilacTransport.requestJson%5BCallExpression%5D%401|sha256=ee5bb6fbbb36e04db1b6e9ece2d78430ddf6ec2694a46821f85601aaa01efeb8",
        identity: "mini-lilac-transport.ts#MiniLilacTransport.requestJson[CallExpression]@1",
        location: {
          file: "mini-lilac-transport.ts",
          line: 671,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
    ],
  },
  "packages/mini-lilac-runtime": {
    "architecture/no-unregistered-decoder": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fconfig.ts%23loadRuntimeConfig%5BCallExpression%5D%401|sha256=077340a28ab9e8472531d1137adf6a32f48fdc32e19b682ee85952c8f35a81cf",
        identity: "src/config.ts#loadRuntimeConfig[CallExpression]@1",
        location: {
          file: "src/config.ts",
          line: 159,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fproviders.ts%23loadProviderConfig%5BCallExpression%5D%401|sha256=608e42a5a35a07a7a0bef68cea11f86fe95b8d3b989511828ffb9c7c4073052d",
        identity: "src/providers.ts#loadProviderConfig[CallExpression]@1",
        location: {
          file: "src/providers.ts",
          line: 155,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fproviders.ts%23loadProviderAuth%5BCallExpression%5D%401|sha256=7e0b16b1af53a2125e5cacab35e73bca547e790d746214123e2630f873a7728c",
        identity: "src/providers.ts#loadProviderAuth[CallExpression]@1",
        location: {
          file: "src/providers.ts",
          line: 180,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fproviders.ts%23writeProviderAuth%5BCallExpression%5D%401|sha256=1b2c2100cafa841354d4b82d511f7618ad3d39cde083cc5a2332c967c81c053e",
        identity: "src/providers.ts#writeProviderAuth[CallExpression]@1",
        location: {
          file: "src/providers.ts",
          line: 184,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmodel-catalog.ts%23parseModelRef%5BCallExpression%5D%401|sha256=a83804c2cae367fede9dfbba709020dcf4fada9b70bf9f7bf97a4fcd7c70cdf7",
        identity: "src/model-catalog.ts#parseModelRef[CallExpression]@1",
        location: {
          file: "src/model-catalog.ts",
          line: 169,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmodel-catalog.ts%23ModelCatalog.constructor%5BCallExpression%5D%401|sha256=b332cf28ad622926d8b501b1185385f84d7cf0a0fb3b70adfc95119f19f47a1c",
        identity: "src/model-catalog.ts#ModelCatalog.constructor[CallExpression]@1",
        location: {
          file: "src/model-catalog.ts",
          line: 348,
          column: 29,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmodel-catalog.ts%23ModelCatalog.constructor%5BCallExpression%5D%401|sha256=7b6df6576b64288ceced8666eb6dbfdfd30b8c67d4f7a0cdfa2ce1d6b1c20ebc",
        identity: "src/model-catalog.ts#ModelCatalog.constructor[CallExpression]@1",
        location: {
          file: "src/model-catalog.ts",
          line: 351,
          column: 29,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmodel-catalog.ts%23ModelCatalog.modelsFromModelsDev%5BCallExpression%5D%401|sha256=3df4600ad0ff53374f415e07def6fa403f889605ebeba32ba911bbceba0139d1",
        identity: "src/model-catalog.ts#ModelCatalog.modelsFromModelsDev[CallExpression]@1",
        location: {
          file: "src/model-catalog.ts",
          line: 457,
          column: 30,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmodel-catalog.ts%23ModelCatalog.loadDiskCache%5BCallExpression%5D%401|sha256=95437fe7d69f9b4a8b8f49c143af8258b0337a1306fbcaa7531741db712e392d",
        identity: "src/model-catalog.ts#ModelCatalog.loadDiskCache[CallExpression]@1",
        location: {
          file: "src/model-catalog.ts",
          line: 562,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmodel-catalog.ts%23ModelCatalog.refresh%5BCallExpression%5D%401|sha256=f8aedf7554499a17d7ca100dd24c2fb3da3617f633a346ca8ce665c4ef48ac12",
        identity: "src/model-catalog.ts#ModelCatalog.refresh[CallExpression]@1",
        location: {
          file: "src/model-catalog.ts",
          line: 748,
          column: 26,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fmodel-catalog.ts%23ModelCatalog.refresh.%3Ccallback%3E%5BCallExpression%5D%401|sha256=7618697284f186293f67873f2324561ec5f61fe283d677da2cc7461a817da1c3",
        identity: "src/model-catalog.ts#ModelCatalog.refresh.<callback>[CallExpression]@1",
        location: {
          file: "src/model-catalog.ts",
          line: 790,
          column: 28,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fskills.ts%23MiniLilacSkillCatalogSnapshot.constructor.%3Ccallback%3E%5BCallExpression%5D%401|sha256=be915445d47ef0856e03d8e495bb88b4d06e85b9b8e1c71c535a6d9e536f44b7",
        identity:
          "src/skills.ts#MiniLilacSkillCatalogSnapshot.constructor.<callback>[CallExpression]@1",
        location: {
          file: "src/skills.ts",
          line: 58,
          column: 7,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fskills.ts%23MiniLilacSkillCatalogSnapshot.load%5BCallExpression%5D%401|sha256=bfd8a6dab6a9636c4cc5b80b6cb293c5cba716b39cb7772e915ce4716abd7d17",
        identity: "src/skills.ts#MiniLilacSkillCatalogSnapshot.load[CallExpression]@1",
        location: {
          file: "src/skills.ts",
          line: 127,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23parseMigratedUiMessage%5BCallExpression%5D%401|sha256=3506929c67bb677b66226dd876a7dd70ca12a1f02a997ce20c8b72994a4a7321",
        identity: "src/sqlite-store.ts#parseMigratedUiMessage[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 536,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23parseMigratedUiMessage%5BCallExpression%5D%401|sha256=d2bf3ee6757426a378cb6579912320d3f15cdd5fddc240a3a07347c84c341fb6",
        identity: "src/sqlite-store.ts#parseMigratedUiMessage[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 540,
          column: 9,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23parseMigratedUiMessage%5BCallExpression%5D%401|sha256=b81a05e8903f8a7569a95ee68f072dd5526155f9e7a16f843ec2d84e871d2010",
        identity: "src/sqlite-store.ts#parseMigratedUiMessage[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 544,
          column: 30,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23parseMigratedUiMessage%5BCallExpression%5D%401|sha256=7880ad43805493606dc1c7ead198409e8cf69b4b2c9b89623b3d2f3f4085e9cd",
        identity: "src/sqlite-store.ts#parseMigratedUiMessage[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 562,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23parseMigratedUiMessage%5BCallExpression%5D%401|sha256=0fe6cca18abc1b478db1f837fb371a128e16321824d8c12c2e68ea2d747b2165",
        identity: "src/sqlite-store.ts#parseMigratedUiMessage[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 571,
          column: 14,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23parseMigratedUserUiMessage%5BCallExpression%5D%401|sha256=56c69dfea86c9bb43ff927b2bc30c9dca239931aebad6c0c7a4a129ec62449db",
        identity: "src/sqlite-store.ts#parseMigratedUserUiMessage[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 592,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23parseStoredUIMessageChunk%5BCallExpression%5D%401|sha256=f7284b91e20045094a32090716651dcd2c734e0ce3dc16aacc9209df01e5b0f4",
        identity: "src/sqlite-store.ts#parseStoredUIMessageChunk[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 775,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23canonicalCommandPayload%5BCallExpression%5D%401|sha256=9cf521f532f45d3ef44e49a5ef571e99de9eb4afdd1ee779b744f57120b9f994",
        identity: "src/sqlite-store.ts#canonicalCommandPayload[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1348,
          column: 50,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23parseHistoryWorkspaceOutcome%5BCallExpression%5D%401|sha256=ab29ec04a334637c70df325092451f3696d8d5795a69dd38b86f117e3fb34a45",
        identity: "src/sqlite-store.ts#parseHistoryWorkspaceOutcome[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1380,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23toSnapshot%5BCallExpression%5D%401|sha256=3bdb7d718a619f9ce16d9b9886b393e75a7d95268f6771dff931ad6daf9e7fd2",
        identity: "src/sqlite-store.ts#toSnapshot[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1393,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23toSnapshot%5BCallExpression%5D%401|sha256=51c8dcdef8782b99eaa602a90d3d8ef8eb2523cf864284968f4e7b1ac3bcc054",
        identity: "src/sqlite-store.ts#toSnapshot[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1401,
          column: 16,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23toRun%5BCallExpression%5D%401|sha256=8a3225e67d7e3034bb703f351116fa6fd4dcff34d7f689bb28e664c4fa7ce1db",
        identity: "src/sqlite-store.ts#toRun[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1415,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23toWorkspace%5BCallExpression%5D%401|sha256=e790b6db959d671e079436d7eba36e780123755ac445195df0d5b2515861784c",
        identity: "src/sqlite-store.ts#toWorkspace[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1431,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23toWorkspaceSnapshot%5BCallExpression%5D%401|sha256=eb4896057dfeece7a1e50333bd1197b260e6c536adde36f1e5a35ef84e58bc91",
        identity: "src/sqlite-store.ts#toWorkspaceSnapshot[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1442,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23toHistoryState%5BCallExpression%5D%401|sha256=feb845e3520526754caef46385bb64e3ebbc2f0b9291744bf05210864451abc7",
        identity: "src/sqlite-store.ts#toHistoryState[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1456,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23toHistoryState%5BCallExpression%5D%401|sha256=0e7164e435d87311c0e63545bf2b8d831f9352e0f215c0b0ee00c710bf98171e",
        identity: "src/sqlite-store.ts#toHistoryState[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1473,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23toMiniMainClaudeBinding%5BCallExpression%5D%401|sha256=526ad13a6084e1dc576e0b88d9da2f9bfafc889a6b733fe1bf12061318b04c4d",
        identity: "src/sqlite-store.ts#toMiniMainClaudeBinding[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1482,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23toMiniMainClaudeAttempt%5BCallExpression%5D%401|sha256=0653080a249cbf97dc3fd5770b41b6ee056d8f4423c20506a933080b43d2ef61",
        identity: "src/sqlite-store.ts#toMiniMainClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1506,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23toMiniNamedClaudeBinding%5BCallExpression%5D%401|sha256=67cbc3b5769ead9118a695e19157713b526aad0074b32414537ee19e8190a51e",
        identity: "src/sqlite-store.ts#toMiniNamedClaudeBinding[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1528,
          column: 34,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23toMiniNamedClaudeAttempt%5BCallExpression%5D%401|sha256=1e31fdfcf48c352e610067754a2a197a6e9c9c6a6680b4c8e4cb95d3970dce84",
        identity: "src/sqlite-store.ts#toMiniNamedClaudeAttempt[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1532,
          column: 34,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23toHistoryTransition%5BCallExpression%5D%401|sha256=01436d807e76f0979246870b64ed4e148568a3835103ddd86fcc39d7bf281ad6",
        identity: "src/sqlite-store.ts#toHistoryTransition[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1536,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23toHistoryTransition%5BCallExpression%5D%401|sha256=a856a40c82dca5b25e64cc8f466ac4441f3bb584336489c07c3476d442c6f4d3",
        identity: "src/sqlite-store.ts#toHistoryTransition[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1548,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23toSessionHistory%5BCallExpression%5D%401|sha256=7d5c1b24089f7cb2bcb14d20b2d0a7721838fd86bc9543063308d5eee89ebe09",
        identity: "src/sqlite-store.ts#toSessionHistory[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1557,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23toHistoryRedoEntry%5BCallExpression%5D%401|sha256=766869dd003b571d42472f1b09a09c892e8e51ed1799c4e80f62f006e4343775",
        identity: "src/sqlite-store.ts#toHistoryRedoEntry[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1568,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23toHistoryOperation%5BCallExpression%5D%401|sha256=555e45a6a77dcf972dfbef92078173dea700fe7b5dbbc1afb36aabfa05351241",
        identity: "src/sqlite-store.ts#toHistoryOperation[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1579,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23toPendingRunFinalization%5BCallExpression%5D%401|sha256=9ef0bdb496d61469064fa56e688b0d3beb441f9f576dc79e48a0e8e9d51d9b8b",
        identity: "src/sqlite-store.ts#toPendingRunFinalization[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1600,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23toPendingRunFinalization%5BCallExpression%5D%401|sha256=38b2c1635d4a528eb76365b31f74d3e32bc5c051793be4955c34be21a130bc91",
        identity: "src/sqlite-store.ts#toPendingRunFinalization[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1617,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23toPendingRunFinalization%5BCallExpression%5D%401|sha256=84cf80e574fb6f8a936c73196bfb87c17e191d05e6feea7b7c1960a399d0cd9d",
        identity: "src/sqlite-store.ts#toPendingRunFinalization[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1624,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23toPendingRunFinalization%5BCallExpression%5D%401|sha256=ac14d030e5cf68bc8670afd3f93419337cad8c02e2f1f6f0f8ef5369da648732",
        identity: "src/sqlite-store.ts#toPendingRunFinalization[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1630,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23readMiniLilacHistoryRecoveryStatus%5BCallExpression%5D%401|sha256=90ce5792abee43d1286cb47276149daad56f575e56eb8f117c1b8df9dc859c3a",
        identity: "src/sqlite-store.ts#readMiniLilacHistoryRecoveryStatus[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1669,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23readMiniLilacHistoryRecoveryStatus%5BCallExpression%5D%401|sha256=b3f85936df370e8b5e4cdef5ac46e5a6213b9746a5635f498ae2491cf706616c",
        identity: "src/sqlite-store.ts#readMiniLilacHistoryRecoveryStatus[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1675,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23readMiniLilacHistoryRecoveryStatus%5BCallExpression%5D%401|sha256=8906f8407c810d296ef1e86a6ed872cf1b9328ee44024a6d4ed959f2d074b97e",
        identity: "src/sqlite-store.ts#readMiniLilacHistoryRecoveryStatus[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1691,
          column: 34,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.initializeSchema%5BCallExpression%5D%401|sha256=c30ca54b0606dce32f2445d078187719f36cdc87a963ed758c718dbc03c29d8b",
        identity: "src/sqlite-store.ts#MiniLilacSqliteStore.initializeSchema[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1750,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.migrateSchemaV4ToV5%5BCallExpression%5D%401|sha256=9882de595e51130db532845fbeb9ebb50c7606669e0aaeaff55564bf5443da8d",
        identity: "src/sqlite-store.ts#MiniLilacSqliteStore.migrateSchemaV4ToV5[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 2332,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.migrateSchemaV4ToV5%5BCallExpression%5D%401|sha256=0fdc163cf32568153f6698e02c2ea74d3cd0dd650fbd1b67ad90e2da9ab7308f",
        identity: "src/sqlite-store.ts#MiniLilacSqliteStore.migrateSchemaV4ToV5[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 2449,
          column: 36,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.migrateSessionHistoryV4%5BCallExpression%5D%401|sha256=b4b2b3533ba98819bc27d3f12539ce0fcd5ecf5264d4d041b54d3116997daf0b",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.migrateSessionHistoryV4[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 2469,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.migrateSessionHistoryV4%5BCallExpression%5D%401|sha256=20e5d800f7496181dbd03a5c81ede3505b97937f8e76d57a4ba8cbb65e29b7fe",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.migrateSessionHistoryV4[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 2487,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.migrateSessionHistoryV4%5BCallExpression%5D%401|sha256=e4aae5cf887ecb7adc0c82fcc88c2f42812fbe61e8fea9827a38e8fd667fdefc",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.migrateSessionHistoryV4[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 2499,
          column: 25,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.migrateSessionHistoryV4%5BCallExpression%5D%401|sha256=46e1d490948c31f6053434f0d643138af398d11049cc1a350b25049f0ba1454c",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.migrateSessionHistoryV4[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 2508,
          column: 28,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.migrateSessionHistoryV4.%3Ccallback%3E%5BCallExpression%5D%401|sha256=f399d0abb65ab24e482bca272f5b7b373a63ef468595022d825578bee1bffd90",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.migrateSessionHistoryV4.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 2529,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.migrateSessionHistoryV4.%3Ccallback%3E%5BCallExpression%5D%401|sha256=88db6390852a54ee4df4348535c35d4b47a2da4963b5fc331af282fd106747fc",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.migrateSessionHistoryV4.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 2539,
          column: 7,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.migrateSchemaV2ToV3%5BCallExpression%5D%401|sha256=137edfba6157ac02751161eccf7dee9aed86a2dc3c8192735e77293eef2fd640",
        identity: "src/sqlite-store.ts#MiniLilacSqliteStore.migrateSchemaV2ToV3[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 2808,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.migrateSchemaV2ToV3.%3Ccallback%3E%5BCallExpression%5D%401|sha256=c6187e3b16b16b3021fffcc38ce1b7b5854b7a0aee14e4e460bf819a8e93fbce",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.migrateSchemaV2ToV3.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 2817,
          column: 25,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.migrateSchemaV2ToV3.%3Ccallback%3E%5BCallExpression%5D%402|sha256=61125cb8d91718e8a7ee7425ba1a98d4189f9719525b279cb90712fbc019658f",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.migrateSchemaV2ToV3.<callback>[CallExpression]@2",
        location: {
          file: "src/sqlite-store.ts",
          line: 2823,
          column: 25,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.migrateSchemaV2ToV3%5BCallExpression%5D%401|sha256=4c2e054d4612de90b54d049d576a1fcbbce45934104ff2f439270d19cbc0c5b8",
        identity: "src/sqlite-store.ts#MiniLilacSqliteStore.migrateSchemaV2ToV3[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 2824,
          column: 7,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.migrateSchemaV2ToV3.%3Ccallback%3E%5BCallExpression%5D%401|sha256=446195c01a03092251f8a95ef1688f688ebb2113e5bfa6888b4d2cff04935a9d",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.migrateSchemaV2ToV3.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 2840,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.migrateSchemaV2ToV3%5BCallExpression%5D%401|sha256=210697ea44e32b0f360b78b1aa1484ab5a190496843bcebe64cab011737ea730",
        identity: "src/sqlite-store.ts#MiniLilacSqliteStore.migrateSchemaV2ToV3[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 2848,
          column: 27,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.migrateSchemaV2ToV3%5BCallExpression%5D%401|sha256=3729969795df7089f1eeeffd10e08f62873b15962565a053c3780a0e876df2ed",
        identity: "src/sqlite-store.ts#MiniLilacSqliteStore.migrateSchemaV2ToV3[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 2850,
          column: 9,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.createSession.%3Ccallback%3E%5BCallExpression%5D%401|sha256=dfa42e9281a4f78ad662c56e947855e63a368440e1e15bd94ab2580f3ab9e008",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.createSession.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 2906,
          column: 25,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.updateActiveRunInputTokens%5BCallExpression%5D%401|sha256=57ccf4c10f476fa51aec49fdf37d750fb94f46278acf164fe6a01d7f3c18272e",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.updateActiveRunInputTokens[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 2999,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.updateSessionBindings.%3Ccallback%3E%5BCallExpression%5D%401|sha256=97152d78237a4cd265951a5538c9b62e1ff4b0791a3a6ed09a6e30d5f891c084",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.updateSessionBindings.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3037,
          column: 42,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.updateSessionBindings.%3Ccallback%3E%5BCallExpression%5D%401|sha256=acbab0c9415fea08a6420956929725f970103948c54c83e1ba2c2489943c9c52",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.updateSessionBindings.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3039,
          column: 30,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.getTodos%5BCallExpression%5D%401|sha256=4a549ba5c79dc83e9cd8d069d40ff88ef63e9df533d139a39254f422ff906301",
        identity: "src/sqlite-store.ts#MiniLilacSqliteStore.getTodos[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3185,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.getTodos%5BCallExpression%5D%401|sha256=18fcba393b512821f7a9cb2544c30bdfce8b4a1ffc872e443aecbd20d02556d3",
        identity: "src/sqlite-store.ts#MiniLilacSqliteStore.getTodos[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3186,
          column: 17,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.getTodos%5BCallExpression%5D%401|sha256=61ea08b50d2cd97dc944a881ee0f3896f220026bf0c6d9f17f9c1462570bad01",
        identity: "src/sqlite-store.ts#MiniLilacSqliteStore.getTodos[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3187,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.replaceTodosForRun%5BCallExpression%5D%401|sha256=219f81a7e6a20521b131e5d7511c4881de8b903b37d0972b5e2c97294ac3f7a6",
        identity: "src/sqlite-store.ts#MiniLilacSqliteStore.replaceTodosForRun[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3194,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.replaceTodosForRun.%3Ccallback%3E%5BCallExpression%5D%401|sha256=f6215b298fa679b9855809524920591d5bd1da3bf816ea82bd7f6cdeadccb5c8",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.replaceTodosForRun.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3233,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.replaceTodosForRun.%3Ccallback%3E%5BCallExpression%5D%401|sha256=bf5130c43b4330293f220189b952ff1d83ee1d1bae13fd1fb809ac8a3bf8d68b",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.replaceTodosForRun.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3234,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.getHistoryStoreMetadata%5BCallExpression%5D%401|sha256=bdc94821a8ce3bee1cae713897d0b0584a31730026b0c29e9ba873ef4f4b736e",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.getHistoryStoreMetadata[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3250,
          column: 17,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.listWorkspaceSnapshots%5BCallExpression%5D%401|sha256=13cad92462364eb5c4f4b2418b0c68e46c19cf9d59289727f169d304c11efc45",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.listWorkspaceSnapshots[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3278,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.setWorkspaceSnapshotAvailability%5BCallExpression%5D%401|sha256=88bb47fda1c157b4f3aedad7ece5dc8270ddd4802da76783a1c90fc78c54cf54",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.setWorkspaceSnapshotAvailability[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3296,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.setWorkspaceSnapshotAvailability%5BCallExpression%5D%401|sha256=751c7caf3a0a3727b523e4800769d64623d13756036a05a8aa802bd3c721ec6b",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.setWorkspaceSnapshotAvailability[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3297,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.deleteUnreferencedWorkspaceSnapshots%5BCallExpression%5D%401|sha256=d22f55482134be35f515b6890192ad235fdb3884eaae27873373518e0bca183a",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.deleteUnreferencedWorkspaceSnapshots[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3326,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.deleteUnreferencedWorkspaceSnapshots%5BCallExpression%5D%401|sha256=14e5c7878a46048d981c038bd6a8f491420ce2b0785c5e84f7a8d8c2df2c36dc",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.deleteUnreferencedWorkspaceSnapshots[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3328,
          column: 9,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.assertWorkspaceHistoryAvailable%5BCallExpression%5D%401|sha256=7a2ff7b725edef0437292259bf811d57222ed3e390c16bca672ff607da2f8ddc",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.assertWorkspaceHistoryAvailable[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3365,
          column: 46,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.createOrReuseWorkspaceSnapshot%5BCallExpression%5D%401|sha256=e656628e8b773cefb78e99bd4e885d36601858c8bee36dd2099e6db5e655e109",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.createOrReuseWorkspaceSnapshot[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3378,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.createOrReuseWorkspaceSnapshot%5BCallExpression%5D%401|sha256=94049130d552bff3d5269ed186030c8e3f222ff3b158dcf2b1ef9722f7981ba8",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.createOrReuseWorkspaceSnapshot[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3379,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.createOrReuseWorkspaceSnapshot%5BCallExpression%5D%401|sha256=38baa94c89858aee344499f01c1fe6e2bd0f38c8ae1ec7886ac854ab6b3dd1b5",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.createOrReuseWorkspaceSnapshot[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3380,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.createOrReuseWorkspaceSnapshot%5BCallExpression%5D%401|sha256=29ff3079ac00a9190433c3073f2c5db5edd320be1d007b4c7d42b0c2a1edc25d",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.createOrReuseWorkspaceSnapshot[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3381,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.createOrReuseWorkspaceSnapshot%5BCallExpression%5D%401|sha256=5b21325484f98fb0bcc54a81afe6b5cfe1b01c6eb463a7ef84b6a7dd03feb7ec",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.createOrReuseWorkspaceSnapshot[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3382,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.getWorkspaceSnapshot%5BCallExpression%5D%401|sha256=2953629a3162febcc416295fcb3aa1d956ea4ec7d99cd5d221aa389bb4049e4f",
        identity: "src/sqlite-store.ts#MiniLilacSqliteStore.getWorkspaceSnapshot[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3418,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.getHistoryStateModelMessages%5BCallExpression%5D%401|sha256=2ff6f43ce3d9ea549ff119e19fdc0ca17efd9b02cb67243c91f45e6f3716b338",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.getHistoryStateModelMessages[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3433,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.getHistoryStateUiMessages%5BCallExpression%5D%401|sha256=efe0ad3620569011f12c95633d45a9fe7920982ee1ca11ab7d9e95ba7da2e790",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.getHistoryStateUiMessages[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3440,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.getMiniMainClaudeState%5BCallExpression%5D%401|sha256=9a14035011ca8a00a491c9a466730c6f59c169af45f97b7a7ed7058b4aef603c",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.getMiniMainClaudeState[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3463,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.getMiniMainClaudeSessionAttempt%5BCallExpression%5D%401|sha256=ad3fc3346dfed88a07638c5c0b487f51aa18f206dc88c7ca58a38a19774aff51",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.getMiniMainClaudeSessionAttempt[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3494,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.reserveMiniMainClaudeSessionAttempt%5BCallExpression%5D%401|sha256=86645d7316ce76e643f126bb97a91302c1daf4daa15e80746968dcaf38fe5e4a",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.reserveMiniMainClaudeSessionAttempt[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3507,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.reserveMiniMainClaudeSessionAttempt.%3Ccallback%3E%5BCallExpression%5D%401|sha256=cd861284311dae2bf12b60c9581e4afd0fe64d993a85e79c9bebc3428d48b6e2",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.reserveMiniMainClaudeSessionAttempt.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3530,
          column: 27,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.recordMiniMainClaudeSessionAttemptOutcome%5BCallExpression%5D%401|sha256=fb1b76d6f771ac341b6438869d08f2022c3ed30cf5bc3620500f420cd62de07c",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.recordMiniMainClaudeSessionAttemptOutcome[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3582,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.getMiniNamedClaudeState%5BCallExpression%5D%401|sha256=f1ac9afb7197ad06c83185a312b12f6179e53624bf9d163856da005ab004511d",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.getMiniNamedClaudeState[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3625,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.getMiniNamedClaudeSessionAttempt%5BCallExpression%5D%401|sha256=d483d74b36879c844bd4fbfacd9f763f27d68b619a23f03b03f66d1b8686a856",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.getMiniNamedClaudeSessionAttempt[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3643,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.getMiniClaudeRetentionDiagnostics.count%5BCallExpression%5D%401|sha256=3bed964f09ec59506d6aa1a12719ba54fb11b1dcec965c150739b194a7dcb3cd",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.getMiniClaudeRetentionDiagnostics.count[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3655,
          column: 7,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.reserveMiniNamedClaudeSessionAttempt%5BCallExpression%5D%401|sha256=c945c898b59e026c4a74ef6da6676b1303361865a93bc8ca688b920bcd63c04c",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.reserveMiniNamedClaudeSessionAttempt[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3698,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.reserveMiniNamedClaudeSessionAttempt.%3Ccallback%3E%5BCallExpression%5D%401|sha256=1bf492af6e1a48420d33b7f3f641b5bef016aafb40098c5714dab884b34332cd",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.reserveMiniNamedClaudeSessionAttempt.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3726,
          column: 27,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.recordMiniNamedClaudeSessionAttemptOutcome%5BCallExpression%5D%401|sha256=5146e7176e39a0a8ae461607aa549420fb53191fee946a57f688c3b48642f49d",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.recordMiniNamedClaudeSessionAttemptOutcome[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3778,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.getHistoryAccounting%5BCallExpression%5D%401|sha256=f695f38d093ac8e9fb496bdae9f690f8a79932f4266929311994baa9bd4bf67a",
        identity: "src/sqlite-store.ts#MiniLilacSqliteStore.getHistoryAccounting[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3891,
          column: 55,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.getHistoryAccounting%5BCallExpression%5D%401|sha256=31e39c4c06d5eadaead3bfad468ec9a29b8c77bd03d2212365a6fbe0bc39c971",
        identity: "src/sqlite-store.ts#MiniLilacSqliteStore.getHistoryAccounting[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3898,
          column: 17,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.internHistoryTranscriptHeads%5BCallExpression%5D%401|sha256=20fc6a84e5db075fdddbc8f50327462728e430edf04338f4f17a807a491e5494",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.internHistoryTranscriptHeads[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3956,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.internHistoryTranscriptHeads%5BCallExpression%5D%401|sha256=4372f30ded832054021b400a7340cba04e12de374cdd735053f2562e0f57cb61",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.internHistoryTranscriptHeads[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3957,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.admitRootPromptHistory%5BCallExpression%5D%401|sha256=1b3e618180cc24d247b71088bb64385e0c4eacd6ed7e5b82e8d4c7b53a5f7c17",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.admitRootPromptHistory[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3969,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.admitRootPromptHistory%5BCallExpression%5D%401|sha256=f639e25bc041c9c1f9a4f98a06c520351017ae51095e175414a8bfb9652c420d",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.admitRootPromptHistory[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3970,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.admitRootPromptHistory%5BCallExpression%5D%401|sha256=2010e77a69c19fc871601be87a6be38e3dbedba9e2e0d40b25840594e30eba36",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.admitRootPromptHistory[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 3972,
          column: 25,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.commitSteeringHistoryBoundary%5BCallExpression%5D%401|sha256=dcabb338ddce5bc7f025852c01bc6b4182e80af591ec1864d96ecb30e60c460f",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.commitSteeringHistoryBoundary[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4082,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.commitSteeringHistoryBoundary%5BCallExpression%5D%401|sha256=dc7b0df6329912ccfbd27265f9fae11a98c9d3b895ec205d744dce6f3c092e9f",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.commitSteeringHistoryBoundary[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4083,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.commitSteeringHistoryBoundary.%3Ccallback%3E%5BCallExpression%5D%401|sha256=5d386a7f3270f733d7d8c26f97c65de005f64d40b1a855c3872a68f2da3615c3",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.commitSteeringHistoryBoundary.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4085,
          column: 7,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.commitSteeringHistoryBoundary.%3Ccallback%3E%5BCallExpression%5D%401|sha256=a03e09bf64ebc63b2f2d4d93ff277bfa0c0844cdea48da4d295c3633181a96f9",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.commitSteeringHistoryBoundary.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4086,
          column: 7,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.commitSteeringHistoryBoundary.%3Ccallback%3E%5BCallExpression%5D%401|sha256=eec2ec72956a707da7d259a1c0d64cb58530c49703edf005ad993a45bd5c0451",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.commitSteeringHistoryBoundary.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4090,
          column: 7,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.commitSteeringHistoryBoundary.%3Ccallback%3E%5BCallExpression%5D%401|sha256=7b9b058d6e6df1d157f175bf5b3f650107f9912e4c52cd9de98af9419faf645d",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.commitSteeringHistoryBoundary.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4160,
          column: 13,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.commitSteeringHistoryBoundary.%3Ccallback%3E%5BCallExpression%5D%402|sha256=ce3d188f1f3cdfebd872bda204593894c596fc6aa1685d4b5f50d774ab56259c",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.commitSteeringHistoryBoundary.<callback>[CallExpression]@2",
        location: {
          file: "src/sqlite-store.ts",
          line: 4164,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.commitSteeringHistoryBoundary.%3Ccallback%3E%5BCallExpression%5D%401|sha256=41e218dd115c5dee1aa910c1cb2b7a229a79bff2fa9cfb3ca855885357fc390e",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.commitSteeringHistoryBoundary.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4167,
          column: 30,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.commitSteeringHistoryBoundary.%3Ccallback%3E%5BCallExpression%5D%401|sha256=6c2548f51370d916437b183c09fefd2879b58b8fca7dd0ab8311ddbde79662bf",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.commitSteeringHistoryBoundary.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4201,
          column: 32,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.commitSteeringHistoryBoundary.%3Ccallback%3E%5BCallExpression%5D%401|sha256=a2cf12a3b39a6ba790cfc1a8322c8a0a799bc5cd084830b056d94c9dc0633c95",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.commitSteeringHistoryBoundary.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4202,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.commitHistoryCompaction%5BCallExpression%5D%401|sha256=9f65a7e501bb4348fbd0a4b462302740e51f683ccd6a0602ea9bf17017d80d8e",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.commitHistoryCompaction[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4281,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.commitHistoryCompaction%5BCallExpression%5D%401|sha256=48e3a9bc93b3c210d4f7859c5b8736cb7fedcee516630995f07f7088df4fcc96",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.commitHistoryCompaction[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4285,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.commitHistoryCompaction%5BCallExpression%5D%401|sha256=582dc24d43cc863bb88d8de8a41f6cc0d2fb9b0c8bac6e65a2fb8ccd78dfd303",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.commitHistoryCompaction[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4286,
          column: 29,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.commitHistoryCompaction.%3Ccallback%3E%5BCallExpression%5D%401|sha256=7bd06c2eb08e9b3969891b12d912c1995399e57658687b6f18cdbcf006baf3ac",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.commitHistoryCompaction.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4364,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.pushHistoryRedo.%3Ccallback%3E%5BCallExpression%5D%401|sha256=7fc47e9425f4df53d211f1d8e1136240c166144352d756d0f515d63a5b1b7be1",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.pushHistoryRedo.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4585,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.commitEmptyHistoryNavigation%5BCallExpression%5D%401|sha256=ccca7c9a535b5e7f67fd601a39a4b6398ddcb05652f6c890224e13f62b36dc32",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.commitEmptyHistoryNavigation[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4628,
          column: 7,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.reserveHistoryOperation%5BCallExpression%5D%401|sha256=3c6537a9f5384cf4c6a647e9f23f9b61c1cef34dd490d0962bb3830e71d6ed2b",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.reserveHistoryOperation[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4702,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.reserveHistoryOperation%5BCallExpression%5D%401|sha256=ed4a8d501ebfbb29131a3edf56478fc3e850c5e8f509db609dc66e320262cd63",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.reserveHistoryOperation[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4703,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.reserveHistoryOperation%5BCallExpression%5D%401|sha256=29f2e5f07e7fbe4eef3c2b848b5106f4e5a507d932ea98c941ee59483826439d",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.reserveHistoryOperation[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4707,
          column: 42,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.skipPreparedHistoryRestore%5BCallExpression%5D%401|sha256=19e316a2565a2e39268104936f75e3425dd09d5110812eafbb61d65eb22586e4",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.skipPreparedHistoryRestore[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4827,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.updateHistoryOperationPhase%5BCallExpression%5D%401|sha256=bc3c9fa04649f1c7fe34691b3380e4863447309593099c351994037218168745",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.updateHistoryOperationPhase[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4854,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.commitHistoryNavigation.%3Ccallback%3E%5BCallExpression%5D%401|sha256=d2549926c6c705813e023f3d42725fad64ce8fff721fd13e5ffb165dcd6d8722",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.commitHistoryNavigation.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4925,
          column: 30,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.commitHistoryNavigation.%3Ccallback%3E%5BCallExpression%5D%401|sha256=45d0a6668dab6ff9f27e3493328ec2d252c327aa74c8e092da94fbbd3939cfa3",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.commitHistoryNavigation.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4930,
          column: 30,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.abandonHistoryNavigation%5BCallExpression%5D%401|sha256=317cd6a1e188b9eb8e083554a0b166c47fa135a520a57a0efa0d3f04377720ef",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.abandonHistoryNavigation[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4995,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.abandonHistoryNavigation%5BCallExpression%5D%401|sha256=d6f9c3414a66327db70ed8df8f027829dd42e1ff0a6f02e8472cc1dbcc8a3317",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.abandonHistoryNavigation[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 4996,
          column: 27,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.abandonHistoryNavigation.%3Ccallback%3E%5BCallExpression%5D%401|sha256=6526f34a5bc5620caa824209170afd1843e60e634cec209a8155768699583343",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.abandonHistoryNavigation.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5019,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.reservePendingRunFinalization%5BCallExpression%5D%401|sha256=e724991f2b65f1de52b7e95045e4a03c920d313bfcd11805dffbd83cd022e50f",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.reservePendingRunFinalization[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5034,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.reservePendingRunFinalization%5BCallExpression%5D%401|sha256=bdc6f25b9e3a618b5f07ec4236a7063e3e0f0b29bea516b54c8396b5006b1d9c",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.reservePendingRunFinalization[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5035,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.reservePendingRunFinalization%5BCallExpression%5D%401|sha256=d9fc8b6751b7a74506656389e70709906412ccb0e30657448771cca7e30f54b1",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.reservePendingRunFinalization[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5036,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.reservePendingRunFinalization%5BCallExpression%5D%401|sha256=14c9d9116d8119ddf9f343a959a5184e2fcf8c29600d86a3b089af5cf7e15fef",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.reservePendingRunFinalization[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5037,
          column: 27,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.reservePendingRunFinalization%5BCallExpression%5D%401|sha256=d8fd1f99bdb0aa4b7f6e5687f09919a0ced5674e5ef7cdc8bf7900cb843b6359",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.reservePendingRunFinalization[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5041,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.reservePendingRunFinalization%5BCallExpression%5D%401|sha256=1ab101d526576e6bd9f59c21f231588486bc46dfe6d37043db492a507533fe46",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.reservePendingRunFinalization[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5045,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.reservePendingRunFinalization%5BCallExpression%5D%401|sha256=5a83c5a2b86df1ba36ed1ab931e1dfa9cf904beebff09740744b7496de3036ca",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.reservePendingRunFinalization[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5049,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.reservePendingRunFinalization%5BCallExpression%5D%401|sha256=259530c7e04744aafd071b70ade9c8c3e5cab80646819a4ef1b9cd95b45b80f5",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.reservePendingRunFinalization[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5059,
          column: 37,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.reservePendingRunFinalization.%3Ccallback%3E%5BCallExpression%5D%401|sha256=e7148a8978bf297724afc814df1cd2f0ab9e4a94dc7d25d2cb7b07920b07a327",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.reservePendingRunFinalization.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5095,
          column: 7,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.reservePendingRunFinalization.%3Ccallback%3E%5BCallExpression%5D%401|sha256=d38728ff401351e5550ecc366afcd29afe7f995e053dcf04dc932953e7c7196d",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.reservePendingRunFinalization.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5100,
          column: 30,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.listRecoverableOpenRootRuns%5BCallExpression%5D%401|sha256=ca0aef8b7406ae700a5ac2cfa75d47ea6d53f0c9562ea453819f4e8e45a5fa88",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.listRecoverableOpenRootRuns[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5163,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.recoverInterruptedRuntimeState.%3Ccallback%3E%5BCallExpression%5D%401|sha256=b0760adf9576d86254153d565d6679ffbc2855a37b08d4fe1074ebd37baa1695",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.recoverInterruptedRuntimeState.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5205,
          column: 35,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.recoverInterruptedRuntimeState.%3Ccallback%3E%5BCallExpression%5D%401|sha256=c2193e38a93b22cf8314db8e50169287d6418197d98c25980cab3cbc9a35c9fc",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.recoverInterruptedRuntimeState.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5281,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.recoverInterruptedRuntimeState.%3Ccallback%3E%5BCallExpression%5D%401|sha256=d69313f96f39966a01818db9c51eedd23c16a3a0d755ed370d67c9925b3a9ab7",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.recoverInterruptedRuntimeState.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5292,
          column: 27,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.commitPendingRunFinalization%5BCallExpression%5D%401|sha256=7b8c96289cbc4add7641c526a9080d9707abc96ce4509a73fa63d743365c4f4b",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.commitPendingRunFinalization[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5337,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.commitPendingRunFinalization%5BCallExpression%5D%401|sha256=5081ec77fd328efed6a1ed5a988854dc5eef4ac69101370650d34a7bfd413103",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.commitPendingRunFinalization[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5341,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.commitPendingRunFinalization%5BCallExpression%5D%401|sha256=1de91d88c92087e504b74d5b605fc9bcd43dfc7282f09a7c82dc030cceaf4068",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.commitPendingRunFinalization[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5345,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.getHistoryStateCanonicalMessageCount%5BCallExpression%5D%401|sha256=f26655208145eb1e62827f43e9cfbfbbbfddc5dfd7eb3740ea9ded89edc4fdf7",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.getHistoryStateCanonicalMessageCount[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5476,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.promoteMiniNamedClaudeBinding%5BCallExpression%5D%401|sha256=4bda2dd0aad9c53d4a507a923f36016d22e5fd29bcee012520987bcc7d0ff1ff",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.promoteMiniNamedClaudeBinding[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5585,
          column: 8,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.getRootPromptSourceStateId%5BCallExpression%5D%401|sha256=6f7f828bceffba8b3c43d2db3e0869fa8c910a725debd4aeaa033d4b930d1428",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.getRootPromptSourceStateId[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5691,
          column: 17,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.requireQuiescentHistorySession%5BCallExpression%5D%401|sha256=f7452dbf3821e89117188d4746c52f2fc8c7ca47c33d702911121c08301792c7",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.requireQuiescentHistorySession[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5769,
          column: 28,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.assertWorkspaceHistoryAvailableForOwner%5BCallExpression%5D%401|sha256=93dae3a11d564db0081150036b529bacf6a21c61c4ef6c3e1fd4240b11d323a7",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.assertWorkspaceHistoryAvailableForOwner[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5815,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.assertWorkspaceHistoryAvailableForOwner%5BCallExpression%5D%401|sha256=856319a45b4198af740cefda899564d5a46893ddc4066ceb1f4c64715777c9eb",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.assertWorkspaceHistoryAvailableForOwner[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5821,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.assertWorkspaceHistoryAvailableForOwner%5BCallExpression%5D%401|sha256=4627af6df884bde8e60bf4f683411c183cb84534450b2ee6b513247f11a53587",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.assertWorkspaceHistoryAvailableForOwner[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5836,
          column: 27,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.getStoredCommand%5BCallExpression%5D%401|sha256=7b80750a9fd202e58c903e4ecf92f8721f29d1fb68086bd8a205320dbf3fca31",
        identity: "src/sqlite-store.ts#MiniLilacSqliteStore.getStoredCommand[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5916,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.parseHistoryNavigationResult%5BCallExpression%5D%401|sha256=89d67d7323ab243b7d7dfebc673c74b34b9d429e7d3453a50ec5575aaa1e41da",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.parseHistoryNavigationResult[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5935,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.parseHistoryNavigationResult%5BCallExpression%5D%401|sha256=e2dc907642bf4da712a48af0da4d03227df76e7ffc8a5773489529005e7fa134",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.parseHistoryNavigationResult[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5943,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.parseHistoryNavigationResult%5BCallExpression%5D%401|sha256=bc3b022cac4c3d3d667c9391f59485a9352084a7c25ab10c0e1f58f7f3b2d606",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.parseHistoryNavigationResult[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5944,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.insertHistoryStateRow%5BCallExpression%5D%401|sha256=ec30e84dab2529afdaf843f2086415e766193bd95ceb1a10e0f68441285d8d5a",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.insertHistoryStateRow[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5999,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.insertHistoryStateRow%5BCallExpression%5D%401|sha256=1aa202a1e3732a85101d57c987afa57e18a45ce437926e922d7069de4d3a2b3f",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.insertHistoryStateRow[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 6000,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.insertHistoryStateRow%5BCallExpression%5D%401|sha256=98182918a81a634b20e4bbc160c820c1176f5299342637c2c7c1dd3f7ae1a23b",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.insertHistoryStateRow[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 6002,
          column: 7,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.insertHistoryStateRow%5BCallExpression%5D%401|sha256=6767462f98a5a67a70dac141f9e28d54523e7cf7d219e6a899711154c23af4ed",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.insertHistoryStateRow[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 6004,
          column: 37,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.insertHistoryStateRow%5BCallExpression%5D%401|sha256=f8f11eab42560c22e6243eb0c8e301f66a1ab0b6bbbbc42bf3a29142b6e728ae",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.insertHistoryStateRow[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 6005,
          column: 34,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.insertHistoryStateRow%5BCallExpression%5D%401|sha256=ebaccd179850eb75eaca54f7048b3b6934a0c30da2fbf0d0ea41050a616e2243",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.insertHistoryStateRow[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 6009,
          column: 11,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.insertHistoryTransitionRow%5BCallExpression%5D%401|sha256=e72762d10dbfc26484a79738ffcf5f66e3e56fd589cb274665470aefdd830c10",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.insertHistoryTransitionRow[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 6062,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.insertHistoryTransitionRow%5BCallExpression%5D%401|sha256=a2d198519a1f3447d1084a1ea0bbb758d3f22c035d1ff30b9f613d41c235a5a9",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.insertHistoryTransitionRow[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 6091,
          column: 25,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.insertHistoryTransitionRow%5BCallExpression%5D%401|sha256=6a9d6f8b5cdda62f8254aae28a51c87e18ecccc286ee1df20dbca683b81f6b8d",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.insertHistoryTransitionRow[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 6092,
          column: 7,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.insertHistoryTransitionRow%5BCallExpression%5D%401|sha256=eff249b5cb91df891e7cf52fedb974d6c0cbaa438ef8d961aece60414f49c7b7",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.insertHistoryTransitionRow[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 6093,
          column: 7,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.insertHistoryTransitionRow%5BCallExpression%5D%401|sha256=ca00f299f9ffcdb2ea9317ea051955754d9a2994e7755ef908ff5108a7afc017",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.insertHistoryTransitionRow[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 6094,
          column: 7,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.insertHistoryTransitionRow%5BCallExpression%5D%401|sha256=3ccb43f933b2a7c6775fa2236911046230eb2184468f0513e7a249bfd5a96d94",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.insertHistoryTransitionRow[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 6095,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.getModelMessages%5BCallExpression%5D%401|sha256=d3503ee6e27fec8fad5b43e5447e23ecbd55cf063360708731345d8ccd3d8a21",
        identity: "src/sqlite-store.ts#MiniLilacSqliteStore.getModelMessages[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 6234,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.getUiMessages%5BCallExpression%5D%401|sha256=a24776c803ecd7872cdcf6df61742338a45ef5b82bbb078bef5fbcaa46c7fc24",
        identity: "src/sqlite-store.ts#MiniLilacSqliteStore.getUiMessages[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 6243,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.internSerializedChain.%3Ccallback%3E%5BCallExpression%5D%401|sha256=ba32781f13c21df89e37d63c075b1a2fe921b2b9f695429aecc73f50f09d68fe",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.internSerializedChain.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 6277,
          column: 25,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.internSerializedChain%5BCallExpression%5D%401|sha256=fe869d5434374ee49de11c90d1116807530c45bcd6032d5a9484d72068579301",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.internSerializedChain[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 6299,
          column: 26,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.internSerializedChain%5BCallExpression%5D%401|sha256=8ffbb06f389cc977a22c8ada166c3588c242d2294a709fe2f5fbc7dd3f67ef56",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.internSerializedChain[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 6312,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.getTranscriptHeads%5BCallExpression%5D%401|sha256=018d1818093557cda4fb2b90bb00bd415688427c515527a74a8c6bab233a47ac",
        identity: "src/sqlite-store.ts#MiniLilacSqliteStore.getTranscriptHeads[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 6332,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.readSerializedChain.%3Ccallback%3E%5BCallExpression%5D%401|sha256=3335f95ed25e9744fad31f1088ad96764ffd39c051cea107bf3d7fb951413346",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.readSerializedChain.<callback>[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 6371,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.getCommandResult%5BCallExpression%5D%401|sha256=2b38be5f66e8267eb675a4d2005cde333af6677dbb37d63614df4bc274ab553b",
        identity: "src/sqlite-store.ts#MiniLilacSqliteStore.getCommandResult[CallExpression]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 6387,
          column: 17,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkspace-history-store.ts%23isMissingExecutable%5BCallExpression%5D%401|sha256=ff6f5fdbc667af25a8982e734354fe5a527e67a1d09aef4050bff5e13038854c",
        identity: "src/workspace-history-store.ts#isMissingExecutable[CallExpression]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 582,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkspace-history-store.ts%23lstatIfExists%5BCallExpression%5D%401|sha256=292c3c2a27768bc428958ad91d88db2889bb38f444a9ff5a22de353b3639a9ca",
        identity: "src/workspace-history-store.ts#lstatIfExists[CallExpression]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 810,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.removeOwnedStore.%3Ccallback%3E%5BCallExpression%5D%401|sha256=c0b7ddbfc07f988bd356e991118fcba07612f3ebd123a42dd1f778f83c1a84be",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.removeOwnedStore.<callback>[CallExpression]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 2079,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.writeRestorePlanManifest%5BCallExpression%5D%401|sha256=72fbfa7197f2f6cceac6ac32b59b0531a0cd1e6baec1a8a095abd38d87d6c446",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.writeRestorePlanManifest[CallExpression]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 2228,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.readRestorePlanManifest%5BCallExpression%5D%401|sha256=ab35eebe4df6bfc7f3f8c90f30ba95c536d2e6640789e4defe13ceda994bb812",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.readRestorePlanManifest[CallExpression]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 2293,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.ensureStore%5BCallExpression%5D%401|sha256=73d26d2121a678887200831bf8a411c8c22e4919ddde571b3c2502964ef8d9ca",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.ensureStore[CallExpression]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 2472,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.verifyOwnershipMarker%5BCallExpression%5D%401|sha256=c557faa67c93a40a1433e2099529bc37133b1872fbe4c95d02c20a0fcabdfd7b",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.verifyOwnershipMarker[CallExpression]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 2582,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.readCaptureCache.%3Ccallback%3E%5BCallExpression%5D%401|sha256=54c6c1674aa6493ddd27d9405c1b035d8ddb76fc3dde1f1b74e4efc6a73999c4",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.readCaptureCache.<callback>[CallExpression]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 2828,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.readCaptureCache%5BCallExpression%5D%401|sha256=dbf3f189a99810d111e71886b967298283ae91699aa097917ed49e7d1c2beaf1",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.readCaptureCache[CallExpression]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 2839,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.writeCaptureCache%5BCallExpression%5D%401|sha256=4ecb2b3ac41a85fca7cc9e889eb6907cfc028ad72d2bf31a28b42eb91364d5a7",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.writeCaptureCache[CallExpression]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 2874,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.readSnapshot%5BCallExpression%5D%401|sha256=782a8e1eaf6a5412676d74369a117a9c7621024b7c874ffca71fded4804f49bb",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.readSnapshot[CallExpression]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 3112,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.createExclusiveTemporaryDirectory%5BCallExpression%5D%401|sha256=4721efb7a62a9e09d56b96c46c6ae5f8fb3ace650f1f814f8d07b5a234cd27da",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.createExclusiveTemporaryDirectory[CallExpression]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 3755,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.createDestinationSibling%5BCallExpression%5D%401|sha256=29dd954410ee17c382c76b3789216884075425dc2102d2039b7aad9b3cccc0dc",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.createDestinationSibling[CallExpression]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 3840,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.applyPreparedRestore.%3Ccallback%3E%5BCallExpression%5D%401|sha256=17b791286583a807a3cdbaa5f9d5fbcb945c28215e0ecd7b49520d905795c4b2",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.applyPreparedRestore.<callback>[CallExpression]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 4148,
          column: 26,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.publishDestinationSibling%5BCallExpression%5D%401|sha256=f2382cbb1b9d9b3fe8e7749ce64e641150c8d87b2984df54441791984e5b699c",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.publishDestinationSibling[CallExpression]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 4336,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.cleanupDestinationArtifacts.%3Ccallback%3E%5BCallExpression%5D%401|sha256=a582b2f79e157946a804c7494fa45a9d0675b6df7b66d74d643330274b4b743d",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.cleanupDestinationArtifacts.<callback>[CallExpression]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 4412,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.cleanupStaleRestoreArtifactsLocked%5BCallExpression%5D%401|sha256=6bfddc9db0866b58742f851495f647283e2f3d57756125ef97f9df353571c5b1",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.cleanupStaleRestoreArtifactsLocked[CallExpression]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 4460,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.cleanupStaleRestoreArtifactsLocked%5BCallExpression%5D%401|sha256=ab624399dc36d422681e9b7080c84ea57df881118e4d14b3689566674e5c32d5",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.cleanupStaleRestoreArtifactsLocked[CallExpression]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 4542,
          column: 29,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.validatedOwnedRestoreArtifactPaths%5BCallExpression%5D%401|sha256=948f2b64466e457248ee24ea78acb57d0f8097ebb914f8cc024171e87c220452",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.validatedOwnedRestoreArtifactPaths[CallExpression]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 4595,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.ensureSnapshotRefCreationMetadata%5BCallExpression%5D%401|sha256=704d1e0fdce65fc910e870efea7647c5cc238953b8695fc0a5e0b7961fa14fd3",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.ensureSnapshotRefCreationMetadata[CallExpression]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 5107,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.readSnapshotRefCreationMetadata%5BCallExpression%5D%401|sha256=f410b78fcf047a7124706bd50afecb8f17ef6cfe190436480ad778873e21f632",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.readSnapshotRefCreationMetadata[CallExpression]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 5152,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.objectTypesUnlocked%5BCallExpression%5D%401|sha256=3c4de5671599cfd842cde7dcd4c9aeab24c9203dd26c53e45a7dc004e712da90",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.objectTypesUnlocked[CallExpression]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 5351,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fwebfetch.ts%23executeWebfetch%5BCallExpression%5D%401|sha256=e91e5b0bd2ae98a1d273ce71e5bf8d5089c01ae244b5b58289a1e1b5fa3067da",
        identity: "src/webfetch.ts#executeWebfetch[CallExpression]@1",
        location: {
          file: "src/webfetch.ts",
          line: 430,
          column: 17,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fwebfetch.ts%23executeWebfetch%5BCallExpression%5D%401|sha256=aceb61ce4b5fee756621905607a17e70d312d4956e4791de50839ea9b746cb27",
        identity: "src/webfetch.ts#executeWebfetch[CallExpression]@1",
        location: {
          file: "src/webfetch.ts",
          line: 522,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23parseSessionConfig%5BCallExpression%5D%401|sha256=2ff8f30558e2c91cbd5155f623117ee483870d51791ebf227061e27e7e36544c",
        identity: "src/session-service.ts#parseSessionConfig[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 330,
          column: 41,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23parseSessionConfig%5BCallExpression%5D%401|sha256=9c9020e3066d49444b93bc2c0249a8d6cd8606bfe553c7b74cfadfeaf9c3a596",
        identity: "src/session-service.ts#parseSessionConfig[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 332,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23compactionEventFor%5BCallExpression%5D%401|sha256=b69937952683a12d483b852e0c0ea1023fd12d67437debc51ffb5d4f11b28e1a",
        identity: "src/session-service.ts#compactionEventFor[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 388,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23generateSubagentSessionName%5BCallExpression%5D%401|sha256=b5b22c394205e8d185d468f1cdb43cc513042fa0680454d1d62d3128201600fd",
        identity: "src/session-service.ts#generateSubagentSessionName[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 627,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23toolOutputDisplayValue%5BCallExpression%5D%401|sha256=1daab170a7aa74ac0c37a8005ffc67c138a7d1d0f28590fde21f02c1cc3a1a91",
        identity: "src/session-service.ts#toolOutputDisplayValue[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 672,
          column: 24,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23%3Ccallback%3E%5BCallExpression%5D%401|sha256=8305c1de35d206dd749f4b375c60e1da40cde08b04b77091a3b6c76fff372e7e",
        identity: "src/session-service.ts#<callback>[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 698,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23browserSafeUsage%5BCallExpression%5D%401|sha256=25971050535b12ee9cea366e56825820506d550a4f3bf3ba1818c8ce166d8696",
        identity: "src/session-service.ts#browserSafeUsage[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 816,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23browserSafeProviderMetadata%5BCallExpression%5D%401|sha256=6cdb4b756037ce335b7f6b6ca7ca90829212fbda70545eff4a7bec5c41e9d7ad",
        identity: "src/session-service.ts#browserSafeProviderMetadata[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 821,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23splitFinalAnswerUIMessage%5BCallExpression%5D%401|sha256=6b2993ae77ffd21eda14a8d8cb02e88e54dd8228470fdc5ec907cf1913ccc3f5",
        identity: "src/session-service.ts#splitFinalAnswerUIMessage[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 938,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23splitFinalAnswerUIMessage%5BCallExpression%5D%401|sha256=47e40464c3d51b9d1acdd8ec3e55e848c1ecffeaeb152726b5458a5febd8d1e8",
        identity: "src/session-service.ts#splitFinalAnswerUIMessage[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 943,
          column: 5,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23chunkMatchesRollback%5BCallExpression%5D%401|sha256=67a24412bfbd53f6602738319f3fdab899f77ce909fa2b5b5551a4281f915485",
        identity: "src/session-service.ts#chunkMatchesRollback[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 1039,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionActor.startPrompt.%3Ccallback%3E%5BCallExpression%5D%401|sha256=e3530e2b84a9a6c94f09568a7703ffc24910fd8dbc6383941b231bde860090bb",
        identity: "src/session-service.ts#SessionActor.startPrompt.<callback>[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 1395,
          column: 29,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionActor.startPrompt.%3Ccallback%3E%5BCallExpression%5D%401|sha256=696b3d97965fa2e2c6e72534c8492e9ae3fb6d1dfdb3b6563a210e554504bda1",
        identity: "src/session-service.ts#SessionActor.startPrompt.<callback>[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 1397,
          column: 27,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionActor.startPrompt.%3Ccallback%3E%5BCallExpression%5D%401|sha256=bd8998d916bab50758e54d80bc73a6050dc83661dc296fb02a3d2d6c072b6ee8",
        identity: "src/session-service.ts#SessionActor.startPrompt.<callback>[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 1401,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionActor.steer.%3Ccallback%3E%5BCallExpression%5D%401|sha256=982daf78a6028b092651e971f2d6c9b8a2e766ffdad2df62bf03a15d8b9a03d1",
        identity: "src/session-service.ts#SessionActor.steer.<callback>[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 4108,
          column: 40,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionActor.interruptQueuedSteering.%3Ccallback%3E%5BCallExpression%5D%401|sha256=b0ef7c5bf46082f11347a1b48993106e8448cba8b8144039f34579ed4cd25210",
        identity:
          "src/session-service.ts#SessionActor.interruptQueuedSteering.<callback>[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 4167,
          column: 19,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionActor.interruptQueuedSteering.%3Ccallback%3E%5BCallExpression%5D%401|sha256=cdcfd7c836113317cca103b073101c4bccaca0df569f18307b2989139c45d07a",
        identity:
          "src/session-service.ts#SessionActor.interruptQueuedSteering.<callback>[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 4198,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionActor.cancel.%3Ccallback%3E%5BCallExpression%5D%401|sha256=6a7b5927d1b0ac8c29c5bb704897469ba72c26f712e0b8111a008281cb7554bb",
        identity: "src/session-service.ts#SessionActor.cancel.<callback>[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 4218,
          column: 40,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionActor.undo.%3Ccallback%3E%5BCallExpression%5D%401|sha256=b90130c4eba335b6aeb4017637e16f7a64b90bdb45303cef855de0001982bb93",
        identity: "src/session-service.ts#SessionActor.undo.<callback>[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 4255,
          column: 7,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionActor.redo.%3Ccallback%3E%5BCallExpression%5D%401|sha256=b210ad57ad9913e6b3bccadf2e2cbd82dbbfafd4c0ba580971978d13ccf247e5",
        identity: "src/session-service.ts#SessionActor.redo.<callback>[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 4263,
          column: 7,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionActor.replayHistoryNavigation%5BCallExpression%5D%401|sha256=0ee1d1895d6268bc738ffc202d941a5345dd9e1977f35403fa34d62657b0faa7",
        identity: "src/session-service.ts#SessionActor.replayHistoryNavigation[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 4308,
          column: 26,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionActor.replayHistoryNavigation%5BCallExpression%5D%401|sha256=e76dca06c18bc0f076c23415431e92126431f448d1e5a269538e6b11fe8dc6e3",
        identity: "src/session-service.ts#SessionActor.replayHistoryNavigation[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 4311,
          column: 9,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionActor.replayHistoryNavigation%5BCallExpression%5D%401|sha256=9557d2a4933484763c73f0706aea6a82338783636f923d3d8f177c13825e5cfa",
        identity: "src/session-service.ts#SessionActor.replayHistoryNavigation[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 4312,
          column: 9,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionActor.compact.%3Ccallback%3E%5BCallExpression%5D%401|sha256=477e68598707fe58fc9072db1ece772500ba2362b04b37047eec217872869d64",
        identity: "src/session-service.ts#SessionActor.compact.<callback>[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 4507,
          column: 42,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionActor.compact.%3Ccallback%3E%5BCallExpression%5D%401|sha256=907f1660c7c32e0c5387712c797a43bccd35751680abda24093bb9f13ad2adba",
        identity: "src/session-service.ts#SessionActor.compact.<callback>[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 4526,
          column: 17,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionActor.runCompaction.event%5BCallExpression%5D%401|sha256=bbb86de61068b549b1387e561aedff806bd7bcc67bfdd7356502c0a0d51c06b6",
        identity: "src/session-service.ts#SessionActor.runCompaction.event[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 4638,
          column: 14,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionActor.summarizeForCompaction%5BCallExpression%5D%401|sha256=687da7fc280e8b827ac8f495c1e47668ef8028d16296744f6b1dec2f389ead50",
        identity: "src/session-service.ts#SessionActor.summarizeForCompaction[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 4771,
          column: 17,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionActor.summarizeForCompaction%5BCallExpression%5D%401|sha256=0eb68a8499edb409720d0c1bf521f89727371eb37b763c53e28bfde095ba47eb",
        identity: "src/session-service.ts#SessionActor.summarizeForCompaction[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 4921,
          column: 15,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionActor.updateBindings.%3Ccallback%3E%5BCallExpression%5D%401|sha256=8b0a2d191914faab130538b35b0200f4eacfdae878c470b7a20c31235441799e",
        identity: "src/session-service.ts#SessionActor.updateBindings.<callback>[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 4941,
          column: 23,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionActor.updateBindings.%3Ccallback%3E%5BCallExpression%5D%401|sha256=b4d6de7661841102f1201ee5b118310f08bb7bd0045c0e145d9f0df4590678f9",
        identity: "src/session-service.ts#SessionActor.updateBindings.<callback>[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 4949,
          column: 30,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionActor.updateBindings.%3Ccallback%3E%5BCallExpression%5D%401|sha256=98411cf61659f50a8d383ca0ad8b064357ef1a875196e7e518809c205984f1b5",
        identity: "src/session-service.ts#SessionActor.updateBindings.<callback>[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 4969,
          column: 44,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionService.constructor%5BCallExpression%5D%401|sha256=6aa8801a247d4c8a82644b18bbf841a0d872953f32fef3b9afb7d8ad298b716a",
        identity: "src/session-service.ts#SessionService.constructor[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 5032,
          column: 34,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionService.collectDelegatedRun%5BCallExpression%5D%401|sha256=71d7bc3f44332569ceb47aa97e3567bf95ceddeb12a083406f74d8b7b0032fe6",
        identity: "src/session-service.ts#SessionService.collectDelegatedRun[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 5909,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionService.collectDelegatedRun%5BCallExpression%5D%401|sha256=2972611519bb7b625699aa49808df6d4a9439223855000cb32d0f5052063df0a",
        identity: "src/session-service.ts#SessionService.collectDelegatedRun[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 5910,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-unregistered-decoder|identity=src%2Fsession-service.ts%23SessionService.interruptQueuedSteering%5BCallExpression%5D%401|sha256=e4d8b46514a0b2bee2d4da4543c69921afda45255ac58d84a607e1b48f2d07bb",
        identity: "src/session-service.ts#SessionService.interruptQueuedSteering[CallExpression]@1",
        location: {
          file: "src/session-service.ts",
          line: 5966,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
    ],
    "architecture/no-domain-unknown": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fproviders.ts%23writeProviderAuth%5BParameter%5D%401|sha256=60a62f306b84b2d0495a4aa095b20f334649927ae854a55b366d4ceb5e1cf9db",
        identity: "src/providers.ts#writeProviderAuth[Parameter]@1",
        location: {
          file: "src/providers.ts",
          line: 183,
          column: 55,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fmodel-catalog.ts%23ModelCatalog.startBackgroundRefresh.%3Ccallback%3E%5BParameter%5D%401|sha256=8be1f90fe8a00d6652322b6947f808d639b34fb987498f4a253b78c920a2a64b",
        identity:
          "src/model-catalog.ts#ModelCatalog.startBackgroundRefresh.<callback>[Parameter]@1",
        location: {
          file: "src/model-catalog.ts",
          line: 399,
          column: 43,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23parseMigratedUiMessage%5BParameter%5D%401|sha256=22e6c130a01a06b5a1d2ec8ea9f59ab9f53bf5db424d5eb253e7bdf91868b8be",
        identity: "src/sqlite-store.ts#parseMigratedUiMessage[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 532,
          column: 33,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23parseMigratedUserUiMessage%5BParameter%5D%401|sha256=8fb0d92a10877b30fb16649a9f284fce236e87a3c7f5f340139aaab4167f3fe2",
        identity: "src/sqlite-store.ts#parseMigratedUserUiMessage[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 587,
          column: 37,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23%3Ccallback%3E%5BParameter%5D%402|sha256=13633916acb6f93ae9052397916d031dbd1e414d41bc43a0966eec445f889f90",
        identity: "src/sqlite-store.ts#<callback>[Parameter]@2",
        location: {
          file: "src/sqlite-store.ts",
          line: 659,
          column: 8,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23parseStoredUIMessageChunk%5BParameter%5D%401|sha256=d864b7613dd4dc7af0ba21e8444efba373eb800cd6e4329ab28c48be5fb386f8",
        identity: "src/sqlite-store.ts#parseStoredUIMessageChunk[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 774,
          column: 43,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23%3Ccallback%3E%5BParameter%5D%403|sha256=f771f7414bab1fa4e9c7e631c443093f666f5b147500f88d38d4c41b7b124d76",
        identity: "src/sqlite-store.ts#<callback>[Parameter]@3",
        location: {
          file: "src/sqlite-store.ts",
          line: 779,
          column: 4,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23serialize%5BParameter%5D%401|sha256=cbaef53c80a5fc890df4aed65de232d0bdbe3cce2a06dd464bc491c3e42500af",
        identity: "src/sqlite-store.ts#serialize[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1326,
          column: 20,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23canonicalJsonValue%5BParameter%5D%401|sha256=1d2c510414b0de6038484127e08aa620ba8320ea5ae6d163ff0a76ae591d0801",
        identity: "src/sqlite-store.ts#canonicalJsonValue[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1334,
          column: 29,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23canonicalCommandPayload%5BParameter%5D%401|sha256=b097d552ea88b4a467c4b1293f7cd1f3112fcb636c80ae050aa22c9b00bcbec3",
        identity: "src/sqlite-store.ts#canonicalCommandPayload[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1346,
          column: 34,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23canonicalValuesEqual%5BParameter%5D%401|sha256=c075bb87d03297974b2b5131e825fff7088750744c98ae7c03d824a555b49ce0",
        identity: "src/sqlite-store.ts#canonicalValuesEqual[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1353,
          column: 31,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23canonicalValuesEqual%5BParameter%5D%401|sha256=ece795d7e285d9e31bc9398efc472b3db6368b20019bc02a670f0dfc4ff1b7f0",
        identity: "src/sqlite-store.ts#canonicalValuesEqual[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1353,
          column: 46,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23isCanonicalPrefix.%3Ccallback%3E%5BParameter%5D%401|sha256=0ab3b030d737c0282d23b50a5390952e3c8e017b964abd3f9dda22c2899c3f2e",
        identity: "src/sqlite-store.ts#isCanonicalPrefix.<callback>[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1371,
          column: 19,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23toSnapshot%5BParameter%5D%401|sha256=fec868f64f91502d8abb3c10263ce52073aaa0b5b060eea50ff3b8574b73bd58",
        identity: "src/sqlite-store.ts#toSnapshot[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1392,
          column: 21,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23toRun%5BParameter%5D%401|sha256=94ebc36f219027f609211a58978cea11e75c23d0c3e424f575d23dc209f39e77",
        identity: "src/sqlite-store.ts#toRun[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1414,
          column: 16,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23toWorkspace%5BParameter%5D%401|sha256=871debc0dcf3bfb65817c405fdd79dc059349ec661c4fd11a4af2b72ec79a325",
        identity: "src/sqlite-store.ts#toWorkspace[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1430,
          column: 22,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23toWorkspaceSnapshot%5BParameter%5D%401|sha256=e4c8d1901e8dec95073a081c3a499aeec1d7e3b058268e912acdaca29876ac47",
        identity: "src/sqlite-store.ts#toWorkspaceSnapshot[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1441,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23toHistoryState%5BParameter%5D%401|sha256=2baaa2716c15db6a1adfd9f7bb0e343b85be005c8dc4398ba9a7f004326c9bcd",
        identity: "src/sqlite-store.ts#toHistoryState[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1455,
          column: 25,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23toMiniMainClaudeBinding%5BParameter%5D%401|sha256=d1308b2f3d62728c3b30963234e7c803f0021f1df8a92890833d3ab1a192837d",
        identity: "src/sqlite-store.ts#toMiniMainClaudeBinding[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1481,
          column: 34,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23toMiniMainClaudeAttempt%5BParameter%5D%401|sha256=f42547d2e937514dabd2d12b318cdc7a19c9539ef8ee9cc9c3440ae3af58837c",
        identity: "src/sqlite-store.ts#toMiniMainClaudeAttempt[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1505,
          column: 34,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23toMiniNamedClaudeBinding%5BParameter%5D%401|sha256=6274e8748d3d3365791b36ed2e6630e8380bfc02194b90c1fe6ae7548e099623",
        identity: "src/sqlite-store.ts#toMiniNamedClaudeBinding[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1527,
          column: 35,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23toMiniNamedClaudeAttempt%5BParameter%5D%401|sha256=73b8a30079214b091320703fe80b5f8ec3e79c8a9644a48ed5b842380ab3a601",
        identity: "src/sqlite-store.ts#toMiniNamedClaudeAttempt[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1531,
          column: 35,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23toHistoryTransition%5BParameter%5D%401|sha256=ee951b32760c43e4696c0d8a4e74697c43530ebb2f9f2e4ba8defec169f856bc",
        identity: "src/sqlite-store.ts#toHistoryTransition[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1535,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23toSessionHistory%5BParameter%5D%401|sha256=9de5b514a6537ad9b0fa37cd107d89df47c2b67dab01d75800c329158e9104c3",
        identity: "src/sqlite-store.ts#toSessionHistory[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1556,
          column: 27,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23toHistoryRedoEntry%5BParameter%5D%401|sha256=d43385ce55336155aa6c88f1c2ae9ba7e72cfcd47c963d7c4ca5444a0bdb9bf0",
        identity: "src/sqlite-store.ts#toHistoryRedoEntry[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1567,
          column: 29,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23toHistoryOperation%5BParameter%5D%401|sha256=267fdec9e8fd761c8b268905a53d18ee34d783669dc238d30c892c3c5ec22bac",
        identity: "src/sqlite-store.ts#toHistoryOperation[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1578,
          column: 29,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23toPendingRunFinalization%5BParameter%5D%401|sha256=001291eff04340601aa0f6c3cc0ff05a672e4ec39074ef79407d3e4171f584cb",
        identity: "src/sqlite-store.ts#toPendingRunFinalization[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 1599,
          column: 35,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.migrateSchemaV2ToV3.%3Ccallback%3E%5BParameter%5D%401|sha256=3e76bc328fee3d2ee25692b2e4fe8f5064c42c5ea921d13fb3034f58c55f5fe8",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.migrateSchemaV2ToV3.<callback>[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 2817,
          column: 15,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.migrateSchemaV2ToV3.%3Ccallback%3E%5BParameter%5D%402|sha256=90c46f99624c9caf0643c13dc56fe683045a8c70ee68ab34090ae1b7d2035194",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.migrateSchemaV2ToV3.<callback>[Parameter]@2",
        location: {
          file: "src/sqlite-store.ts",
          line: 2823,
          column: 15,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.migrateSchemaV2ToV3.%3Ccallback%3E%5BParameter%5D%403|sha256=ef32dcb17c286b66796547c94fbb725d273ff67465606dabc3318a9eac2b1426",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.migrateSchemaV2ToV3.<callback>[Parameter]@3",
        location: {
          file: "src/sqlite-store.ts",
          line: 2840,
          column: 13,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.listSessions.%3Ccallback%3E%5BParameter%5D%401|sha256=4adce7f6b13ebe9274231481cd888eed594738c3020ed0a3450d827a24a46412",
        identity: "src/sqlite-store.ts#MiniLilacSqliteStore.listSessions.<callback>[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 2968,
          column: 13,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.parseHistoryNavigationResult%5BParameter%5D%401|sha256=963ddf4ceff53bac2324fa308c26338fea1b1690d05906ababc21b70fa97ae0f",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.parseHistoryNavigationResult[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 5931,
          column: 5,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.internSerializedChain.%3Ccallback%3E%5BParameter%5D%401|sha256=991aa2e1df690d3719ff87f6c89d02c08ba7a43ebf39dffe40adc4e5c2d6ecfe",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.internSerializedChain.<callback>[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 6277,
          column: 15,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.readSerializedChain.%3Ccallback%3E%5BParameter%5D%401|sha256=11242c708e426f25b8e8c5974e49305533d13a01bcfcd374284a941d702b65af",
        identity:
          "src/sqlite-store.ts#MiniLilacSqliteStore.readSerializedChain.<callback>[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 6371,
          column: 13,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsqlite-store.ts%23MiniLilacSqliteStore.saveCommandResult%5BParameter%5D%401|sha256=f545ec6bafd72e4d4404867a741d03a11b9b629370ac88b23257b8e43784d861",
        identity: "src/sqlite-store.ts#MiniLilacSqliteStore.saveCommandResult[Parameter]@1",
        location: {
          file: "src/sqlite-store.ts",
          line: 6455,
          column: 5,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkspace-history-store.ts%23isMissingExecutable%5BParameter%5D%401|sha256=31c0ccaa21b44f492d668d171524400b5c5657464725a13111eecf5cde216c65",
        identity: "src/workspace-history-store.ts#isMissingExecutable[Parameter]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 581,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkspace-history-store.ts%23describeError%5BParameter%5D%401|sha256=ae08652c407a679028dea09f70ac25d288497749eee117aadc5c8f97eed5cab1",
        identity: "src/workspace-history-store.ts#describeError[Parameter]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 776,
          column: 24,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.removeOwnedStore.%3Ccallback%3E%5BParameter%5D%401|sha256=de64fa42034ec7b62b453f289f1653266888fddda112845c17199ea11a19159c",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.removeOwnedStore.<callback>[Parameter]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 2078,
          column: 44,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.ensureStore.%3Ccallback%3E%5BParameter%5D%401|sha256=c4f05eab2688c5d55485de93827e1a73374c5e929ca9f87d75fa026c05506193",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.ensureStore.<callback>[Parameter]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 2407,
          column: 57,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.readCaptureCache.%3Ccallback%3E%5BParameter%5D%401|sha256=b2b92f31d3d08e96aa80a58d55536aa22963e4207b1cce0063aaa422fd839c33",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.readCaptureCache.<callback>[Parameter]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 2827,
          column: 70,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.applyPreparedRestore.%3Ccallback%3E%5BParameter%5D%401|sha256=88b7b1d2c23e22e363cb4497d7b6ec3238eb8c650e9ac216ce48832a40e14a84",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.applyPreparedRestore.<callback>[Parameter]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 4147,
          column: 42,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.cleanupDestinationArtifacts.%3Ccallback%3E%5BParameter%5D%401|sha256=ceaccd135add5adb34b9b5c8126bc0670bf8adc2bc731970f0fbaffb92035bbc",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.cleanupDestinationArtifacts.<callback>[Parameter]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 4411,
          column: 42,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.emitVerificationFailure%5BParameter%5D%401|sha256=827eedf413d37f167643d83c7d483197217ee160f83dcb6d569dff0b60b48b51",
        identity:
          "src/workspace-history-store.ts#WorkspaceHistoryStore.emitVerificationFailure[Parameter]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 5668,
          column: 5,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fworkspace-history-store.ts%23WorkspaceHistoryStore.withContext%5BParameter%5D%401|sha256=b1e824a422e5d30433b1ed8faadeaaf1c96300aab55f153d0447a63daa7e6ca5",
        identity: "src/workspace-history-store.ts#WorkspaceHistoryStore.withContext[Parameter]@1",
        location: {
          file: "src/workspace-history-store.ts",
          line: 5704,
          column: 23,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fwebfetch.ts%23waitWithAbort.%3Ccallback%3E.%3Ccallback%3E%5BParameter%5D%401|sha256=c6226d0f76755efb7d611b9337a007a0b1aa6aa4067dd8a0558edfde617673ef",
        identity: "src/webfetch.ts#waitWithAbort.<callback>.<callback>[Parameter]@1",
        location: {
          file: "src/webfetch.ts",
          line: 232,
          column: 8,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fwebfetch.ts%23executeWebfetch%5BParameter%5D%401|sha256=f894cd13e7525a9541fc3e1512249d92cc3c2fbd25b653b747b686ac80bfd29c",
        identity: "src/webfetch.ts#executeWebfetch[Parameter]@1",
        location: {
          file: "src/webfetch.ts",
          line: 426,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsession-service.ts%23sha256Fingerprint%5BParameter%5D%401|sha256=39c4c71a9f1de97d00a1f4c96c1fcfe9596b40fafe992e6226c6c9aff2a6b726",
        identity: "src/session-service.ts#sha256Fingerprint[Parameter]@1",
        location: {
          file: "src/session-service.ts",
          line: 248,
          column: 28,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsession-service.ts%23toolOutputDisplayValue%5BParameter%5D%401|sha256=e25e553e77216159d386eba9291e2467ede0d3c0cc139ab04bed9986d321c051",
        identity: "src/session-service.ts#toolOutputDisplayValue[Parameter]@1",
        location: {
          file: "src/session-service.ts",
          line: 669,
          column: 59,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsession-service.ts%23serializedUtf8Bytes%5BParameter%5D%401|sha256=2135d1270fbc22c01b261ecd275dbed9ca622fd876652d074f4058b36ae0d7d6",
        identity: "src/session-service.ts#serializedUtf8Bytes[Parameter]@1",
        location: {
          file: "src/session-service.ts",
          line: 679,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsession-service.ts%23controlCommandRequest%5BParameter%5D%401|sha256=f7543f4f1754ecb98c337e548ac4db499cc62416ca4e62fc1cebe91555a7d241",
        identity: "src/session-service.ts#controlCommandRequest[Parameter]@1",
        location: {
          file: "src/session-service.ts",
          line: 738,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsession-service.ts%23browserSafeProviderMetadata%5BParameter%5D%401|sha256=0637c92779cefe2ba9931d4c3d9a51a6e7e0a67a928d9ce09c1f2816177674e3",
        identity: "src/session-service.ts#browserSafeProviderMetadata[Parameter]@1",
        location: {
          file: "src/session-service.ts",
          line: 819,
          column: 38,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsession-service.ts%23SessionActor.buildAgent.decideTurnError%5BParameter%5D%401|sha256=5e4900cf61d39081016fac604007a7de115a0d69e5e42d0533b219f4b2716b4c",
        identity: "src/session-service.ts#SessionActor.buildAgent.decideTurnError[Parameter]@1",
        location: {
          file: "src/session-service.ts",
          line: 2318,
          column: 7,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsession-service.ts%23SessionActor.buildAgent.turnErrorHandler%5BParameter%5D%401|sha256=d44e3f9b451d8afe1603753582bb75431eb67769698a62cfc52fe5d4f54027ac",
        identity: "src/session-service.ts#SessionActor.buildAgent.turnErrorHandler[Parameter]@1",
        location: {
          file: "src/session-service.ts",
          line: 2344,
          column: 7,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsession-service.ts%23SessionActor.buildAgent.onServerCompactionError%5BParameter%5D%401|sha256=8c7127f1d21717d239770e301ba945502df8324483781ab06331e60f50a21abe",
        identity:
          "src/session-service.ts#SessionActor.buildAgent.onServerCompactionError[Parameter]@1",
        location: {
          file: "src/session-service.ts",
          line: 2470,
          column: 33,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsession-service.ts%23SessionActor.executeTopLevelRun.onTimeout.%3Ccallback%3E%5BParameter%5D%401|sha256=795c1b23d35fb9dc210cbed7bb8c398c85b379ec4858c7f81f914abf31314e35",
        identity:
          "src/session-service.ts#SessionActor.executeTopLevelRun.onTimeout.<callback>[Parameter]@1",
        location: {
          file: "src/session-service.ts",
          line: 3102,
          column: 18,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsession-service.ts%23SessionActor.reportEventFailure%5BParameter%5D%401|sha256=b91696fabd803b37b74777707bc3ac747c667804da9c6957ea223a68d2973931",
        identity: "src/session-service.ts#SessionActor.reportEventFailure[Parameter]@1",
        location: {
          file: "src/session-service.ts",
          line: 3433,
          column: 45,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fmini-lilac-runtime|rule=architecture%2Fno-domain-unknown|identity=src%2Fsession-service.ts%23SessionActor.summarizeForCompaction.onServerCompactionError%5BParameter%5D%401|sha256=4c2a28a47dd62e3b266b77baf88f94c6747a236174ef1217aa5860fa1d139571",
        identity:
          "src/session-service.ts#SessionActor.summarizeForCompaction.onServerCompactionError[Parameter]@1",
        location: {
          file: "src/session-service.ts",
          line: 4904,
          column: 33,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
    ],
  },
  "packages/plugin-runtime": {
    "architecture/no-unknown-assertion": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fplugin-runtime|rule=architecture%2Fno-unknown-assertion|identity=discovery.ts%23discoverExternalToolPlugins%5BAsExpression%5D%401|sha256=ce01ed4bad1d79b0cb2e25b221cf4b9599f064eecaba08acd891a51da9c2cc49",
        identity: "discovery.ts#discoverExternalToolPlugins[AsExpression]@1",
        location: {
          file: "discovery.ts",
          line: 116,
          column: 23,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fplugin-runtime|rule=architecture%2Fno-unknown-assertion|identity=discovery.ts%23discoverExternalToolPlugins%5BAsExpression%5D%402|sha256=e07ad52c354dbe2458688e796886971d7bb47c1f15af38752fd5ed98b706f5d9",
        identity: "discovery.ts#discoverExternalToolPlugins[AsExpression]@2",
        location: {
          file: "discovery.ts",
          line: 134,
          column: 25,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
    ],
    "architecture/no-domain-unknown": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fplugin-runtime|rule=architecture%2Fno-domain-unknown|identity=types.ts%23%3Cmodule%3E%5BParameter%5D%401|sha256=48b47b7bce85aa1f3211036f87eedc79f59757c01ce43390f4169649a883580b",
        identity: "types.ts#<module>[Parameter]@1",
        location: {
          file: "types.ts",
          line: 114,
          column: 5,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fplugin-runtime|rule=architecture%2Fno-domain-unknown|identity=types.ts%23%3Cmodule%3E%5BParameter%5D%402|sha256=180a5898ecf88e4a8524607b669af72301f8214e56064622cba13cf358585024",
        identity: "types.ts#<module>[Parameter]@2",
        location: {
          file: "types.ts",
          line: 117,
          column: 15,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fplugin-runtime|rule=architecture%2Fno-domain-unknown|identity=loader.ts%23isObject%5BParameter%5D%401|sha256=d276b01196919dc7e36527257121cde9a5c32393ad28cd9302c58250e2f26f97",
        identity: "loader.ts#isObject[Parameter]@1",
        location: {
          file: "loader.ts",
          line: 7,
          column: 19,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fplugin-runtime|rule=architecture%2Fno-domain-unknown|identity=loader.ts%23isPluginMeta%5BParameter%5D%401|sha256=6afdc81a5587838cbc880adce681810cd3ab3960f6f34654f6b770ca6bbb8268",
        identity: "loader.ts#isPluginMeta[Parameter]@1",
        location: {
          file: "loader.ts",
          line: 11,
          column: 23,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fplugin-runtime|rule=architecture%2Fno-domain-unknown|identity=loader.ts%23isLilacToolPlugin%5BParameter%5D%401|sha256=936baabe2adccc9dc22250a6f3021e5ccc37c02e4e3f85d2a7a7240f701f12f8",
        identity: "loader.ts#isLilacToolPlugin[Parameter]@1",
        location: {
          file: "loader.ts",
          line: 16,
          column: 28,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fplugin-runtime|rule=architecture%2Fno-domain-unknown|identity=manager.ts%23toErrorMessage%5BParameter%5D%401|sha256=b82ccaaabffb832722dc8dd55916a9fbd6bed0b7ea70ddf05705b14b2fa85938",
        identity: "manager.ts#toErrorMessage[Parameter]@1",
        location: {
          file: "manager.ts",
          line: 27,
          column: 25,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fplugin-runtime|rule=architecture%2Fno-domain-unknown|identity=manager.ts%23isLevel1ToolSpec%5BParameter%5D%401|sha256=b18f0b11569b1e7b5b3d65004eed86c5f957391883b1637a55f2bb80562faefd",
        identity: "manager.ts#isLevel1ToolSpec[Parameter]@1",
        location: {
          file: "manager.ts",
          line: 580,
          column: 34,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
    ],
    "architecture/no-rich-unknown-predicate": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fplugin-runtime|rule=architecture%2Fno-rich-unknown-predicate|identity=loader.ts%23isObject%5BFunctionDeclaration%5D%401|sha256=a7b8dfb3efb98a0964ec1dfeae18f27d9e03ddf4b268a9bd717aeb0b03d7b2ff",
        identity: "loader.ts#isObject[FunctionDeclaration]@1",
        location: {
          file: "loader.ts",
          line: 7,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fplugin-runtime|rule=architecture%2Fno-rich-unknown-predicate|identity=loader.ts%23isPluginMeta%5BFunctionDeclaration%5D%401|sha256=dd4e5087cb23c45f7ce2232da850423aea77fb7aadc8ab889be0f73b58504a4e",
        identity: "loader.ts#isPluginMeta[FunctionDeclaration]@1",
        location: {
          file: "loader.ts",
          line: 11,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fplugin-runtime|rule=architecture%2Fno-rich-unknown-predicate|identity=loader.ts%23isLilacToolPlugin%5BFunctionDeclaration%5D%401|sha256=42588655507498bb54a201d9d398f0cf12236a44e8a57a272ac41c68d9838821",
        identity: "loader.ts#isLilacToolPlugin[FunctionDeclaration]@1",
        location: {
          file: "loader.ts",
          line: 16,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fplugin-runtime|rule=architecture%2Fno-rich-unknown-predicate|identity=manager.ts%23isLevel1ToolSpec%5BFunctionDeclaration%5D%401|sha256=c2de0d402ed10bcde6849926bfb860411f3f3781764f767710bf81f0654aab2c",
        identity: "manager.ts#isLevel1ToolSpec[FunctionDeclaration]@1",
        location: {
          file: "manager.ts",
          line: 580,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
    ],
  },
  "packages/remote-fs-runner": {
    "architecture/no-rich-unknown-predicate": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fremote-fs-runner|rule=architecture%2Fno-rich-unknown-predicate|identity=src%2Fcli.ts%23isRecord%5BFunctionDeclaration%5D%401|sha256=c49492500c1ee9627a9f20463d19c4e6205b5eca6c989d32553db947263987f8",
        identity: "src/cli.ts#isRecord[FunctionDeclaration]@1",
        location: {
          file: "src/cli.ts",
          line: 33,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
    ],
    "architecture/no-domain-unknown": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fremote-fs-runner|rule=architecture%2Fno-domain-unknown|identity=src%2Fcli.ts%23isRecord%5BParameter%5D%401|sha256=dfdd048dd0c2e16cb1d372a2be512e7dfbe1213dc1195423dc0dc948af6e4b1a",
        identity: "src/cli.ts#isRecord[Parameter]@1",
        location: {
          file: "src/cli.ts",
          line: 33,
          column: 19,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fremote-fs-runner|rule=architecture%2Fno-domain-unknown|identity=src%2Fcli.ts%23numberOrUndefined%5BParameter%5D%401|sha256=6ce6d27d950ea2b5c1979ca5146a2cda26c2096836ae63457b93ab7a204229e6",
        identity: "src/cli.ts#numberOrUndefined[Parameter]@1",
        location: {
          file: "src/cli.ts",
          line: 37,
          column: 28,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fremote-fs-runner|rule=architecture%2Fno-domain-unknown|identity=src%2Fcli.ts%23stringArray%5BParameter%5D%401|sha256=c83a3e05ce10106c365b3db84621ad48abbe4e9a2e509ee9a5c673975ad1fd8a",
        identity: "src/cli.ts#stringArray[Parameter]@1",
        location: {
          file: "src/cli.ts",
          line: 46,
          column: 22,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fremote-fs-runner|rule=architecture%2Fno-domain-unknown|identity=src%2Fcli.ts%23ordinaryFileStartOrUndefined%5BParameter%5D%401|sha256=4adc3abd9dd3dbc47692a7d007f08f06e73a08daf816ce2212770bcac90ba63b",
        identity: "src/cli.ts#ordinaryFileStartOrUndefined[Parameter]@1",
        location: {
          file: "src/cli.ts",
          line: 50,
          column: 39,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fremote-fs-runner|rule=architecture%2Fno-domain-unknown|identity=src%2Fcli.ts%23parseEnvelope%5BParameter%5D%401|sha256=7aa6986d62678de8ad6d488848e8b63e8308bc62443a326c82ce7ba344108a15",
        identity: "src/cli.ts#parseEnvelope[Parameter]@1",
        location: {
          file: "src/cli.ts",
          line: 71,
          column: 24,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fremote-fs-runner|rule=architecture%2Fno-domain-unknown|identity=src%2Fcli.ts%23writeJson%5BParameter%5D%401|sha256=327fcd872d55abab41a27bf565e3b84bc6a424b18b20f9af14784bac9f76f298",
        identity: "src/cli.ts#writeJson[Parameter]@1",
        location: {
          file: "src/cli.ts",
          line: 126,
          column: 20,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fremote-fs-runner|rule=architecture%2Fno-domain-unknown|identity=src%2Fcli.ts%23responseError%5BParameter%5D%401|sha256=7224500cf851a22599988cd390e4f5ba96a3829e07d2fa774513991917df8ad8",
        identity: "src/cli.ts#responseError[Parameter]@1",
        location: {
          file: "src/cli.ts",
          line: 134,
          column: 24,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fremote-fs-runner|rule=architecture%2Fno-domain-unknown|identity=src%2Fcli.ts%23normalizeEditOutput%5BParameter%5D%401|sha256=800c28c28603719182dda0fca1bee63abd538dcc8a2de27c541c1924856bfb72",
        identity: "src/cli.ts#normalizeEditOutput[Parameter]@1",
        location: {
          file: "src/cli.ts",
          line: 138,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fremote-fs-runner|rule=architecture%2Fno-domain-unknown|identity=src%2Fcli.ts%23connectOnce%5BParameter%5D%401|sha256=c7e2b805c3df55f4ce5aee2ef8e5901568afc846a85fcd87918e8ddf11e5929e",
        identity: "src/cli.ts#connectOnce[Parameter]@1",
        location: {
          file: "src/cli.ts",
          line: 276,
          column: 22,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fremote-fs-runner|rule=architecture%2Fno-domain-unknown|identity=src%2Fcli.ts%23connectOnce.%3Ccallback%3E.settleReject%5BParameter%5D%401|sha256=7261645f9e35c56f8439d249204f79084afa08042cd607e93df243d076cfc944",
        identity: "src/cli.ts#connectOnce.<callback>.settleReject[Parameter]@1",
        location: {
          file: "src/cli.ts",
          line: 282,
          column: 27,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Fremote-fs-runner|rule=architecture%2Fno-domain-unknown|identity=src%2Fcli.ts%23tryConnectUntil%5BParameter%5D%401|sha256=0bc13f5aae6cc66bfa18b7350a58be5ee811db8f54da2e6dde4e0ddf346dd45c",
        identity: "src/cli.ts#tryConnectUntil[Parameter]@1",
        location: {
          file: "src/cli.ts",
          line: 329,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
    ],
  },
  "packages/tool-results": {
    "architecture/no-rich-unknown-predicate": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Ftool-results|rule=architecture%2Fno-rich-unknown-predicate|identity=src%2Ftool-result-artifact-store.ts%23isArtifactMetadata%5BFunctionDeclaration%5D%401|sha256=936663cf15bc4c996b04decf0e5ca98478533ef06d1114322b1e55f45c35eec7",
        identity: "src/tool-result-artifact-store.ts#isArtifactMetadata[FunctionDeclaration]@1",
        location: {
          file: "src/tool-result-artifact-store.ts",
          line: 126,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
    ],
    "architecture/no-domain-unknown": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Ftool-results|rule=architecture%2Fno-domain-unknown|identity=src%2Ftool-result-artifact-store.ts%23isArtifactMetadata%5BParameter%5D%401|sha256=17f6f0524bf45bd4ae3fa21d6ce86af3c105b1c750bca04e67cb566607e836f6",
        identity: "src/tool-result-artifact-store.ts#isArtifactMetadata[Parameter]@1",
        location: {
          file: "src/tool-result-artifact-store.ts",
          line: 126,
          column: 29,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
    ],
  },
  "packages/utils": {
    "architecture/no-unregistered-decoder": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-unregistered-decoder|identity=agent-prompts.ts%23parsePromptTemplateState%5BCallExpression%5D%401|sha256=ce7c126fabce2ea6d3f66f2449602dd3d5f2525dc0574c75d634722fcd69af64",
        identity: "agent-prompts.ts#parsePromptTemplateState[CallExpression]@1",
        location: {
          file: "agent-prompts.ts",
          line: 146,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-unregistered-decoder|identity=codex-oauth.ts%23parseJwtClaims%5BCallExpression%5D%401|sha256=7d77e6a0b25525ce7d431d85338be9db1b237535524ca733e646ebb44a0cf882",
        identity: "codex-oauth.ts#parseJwtClaims[CallExpression]@1",
        location: {
          file: "codex-oauth.ts",
          line: 53,
          column: 12,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-unregistered-decoder|identity=codex-oauth.ts%23extractAccountIdFromClaims%5BCallExpression%5D%401|sha256=cd17f06d5f6a8a05aa5a08bd3fad5c6eac0bfba0c0f1089b3890a99c67747459",
        identity: "codex-oauth.ts#extractAccountIdFromClaims[CallExpression]@1",
        location: {
          file: "codex-oauth.ts",
          line: 65,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-unregistered-decoder|identity=codex-oauth.ts%23extractAccountIdFromClaims%5BCallExpression%5D%401|sha256=ff1890480f36d699c9616eb42422f61a8b65fe02d43180f06d0ab117c6e36735",
        identity: "codex-oauth.ts#extractAccountIdFromClaims[CallExpression]@1",
        location: {
          file: "codex-oauth.ts",
          line: 72,
          column: 20,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-unregistered-decoder|identity=codex-oauth.ts%23readCodexTokens%5BCallExpression%5D%401|sha256=8ef55d29e1efb448aed3e4950823c15d157e984603ccb79866aede1c14e6f4c8",
        identity: "codex-oauth.ts#readCodexTokens[CallExpression]@1",
        location: {
          file: "codex-oauth.ts",
          line: 173,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-unregistered-decoder|identity=codex-oauth.ts%23writeCodexTokens%5BCallExpression%5D%401|sha256=cc27424fcc5c2c51edc6c1ca8e7439c95e82bd2e6f93cf03ef5a9b948f5a8885",
        identity: "codex-oauth.ts#writeCodexTokens[CallExpression]@1",
        location: {
          file: "codex-oauth.ts",
          line: 180,
          column: 21,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-unregistered-decoder|identity=codex-oauth.ts%23exchangeCodeForTokens%5BCallExpression%5D%401|sha256=90c15a34cd3717a6f093e222b74041bda5455b1fad7e4523a8ef9973f4c5f5ae",
        identity: "codex-oauth.ts#exchangeCodeForTokens[CallExpression]@1",
        location: {
          file: "codex-oauth.ts",
          line: 264,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-unregistered-decoder|identity=codex-oauth.ts%23refreshAccessToken%5BCallExpression%5D%401|sha256=da23aace267d9081d52e1b1c60000d07cc85dc3fad5f4de059544436ef9ca7ed",
        identity: "codex-oauth.ts#refreshAccessToken[CallExpression]@1",
        location: {
          file: "codex-oauth.ts",
          line: 282,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-unregistered-decoder|identity=core-config%2Fv1.ts%23parseCoreConfigV1%5BCallExpression%5D%401|sha256=c401c952afecfa5598d40981868a3e88d32efc30fcf6a563224f68a889c43e19",
        identity: "core-config/v1.ts#parseCoreConfigV1[CallExpression]@1",
        location: {
          file: "core-config/v1.ts",
          line: 684,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-unregistered-decoder|identity=core-config%2Fv2.ts%23parseCoreConfigV2%5BCallExpression%5D%401|sha256=c3c4680a110f51be541aaf378c0cb70e799b38f6828b95c3abde5a34727ed702",
        identity: "core-config/v2.ts#parseCoreConfigV2[CallExpression]@1",
        location: {
          file: "core-config/v2.ts",
          line: 648,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-unregistered-decoder|identity=custom-commands.ts%23discoverCustomCommands%5BCallExpression%5D%401|sha256=26878c73621536e051cf098f494d7f4549766f60fb65537a9499bc05df723bc3",
        identity: "custom-commands.ts#discoverCustomCommands[CallExpression]@1",
        location: {
          file: "custom-commands.ts",
          line: 214,
          column: 22,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-unregistered-decoder|identity=server-compaction-request.ts%23prepareServerCompactionRequest%5BCallExpression%5D%401|sha256=6900a08fcfe1244ee5ef9e5b72b54dc5da4e4f0e6ae29f4f09372798f3effe12",
        identity: "server-compaction-request.ts#prepareServerCompactionRequest[CallExpression]@1",
        location: {
          file: "server-compaction-request.ts",
          line: 86,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-unregistered-decoder|identity=server-compaction-request.ts%23prepareServerCompactionRequest.%3Ccallback%3E%5BCallExpression%5D%401|sha256=6f25781aafa2c2c14e3fd8df862e3e54346c607655d49dcdf9d743883d1641d8",
        identity:
          "server-compaction-request.ts#prepareServerCompactionRequest.<callback>[CallExpression]@1",
        location: {
          file: "server-compaction-request.ts",
          line: 94,
          column: 16,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-unregistered-decoder|identity=model-message-provider-options.ts%23openAIMessagePhase%5BCallExpression%5D%401|sha256=1833c055d4e4d80ad430f9e5894b65f602455b5c3cbd3ed9d7f4c98689abbd43",
        identity: "model-message-provider-options.ts#openAIMessagePhase[CallExpression]@1",
        location: {
          file: "model-message-provider-options.ts",
          line: 22,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-unregistered-decoder|identity=model-message-provider-options.ts%23isOpenAICompactionPart%5BCallExpression%5D%401|sha256=4f1addb8206685662181bd1bfdebdb2edc513767220bad0f2ac088161028637e",
        identity: "model-message-provider-options.ts#isOpenAICompactionPart[CallExpression]@1",
        location: {
          file: "model-message-provider-options.ts",
          line: 27,
          column: 10,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-unregistered-decoder|identity=skills.ts%23parseSkillMarkdown%5BCallExpression%5D%401|sha256=06e3d79747f9e0aad6e881611769aa806f41670c42c99ed01fe2e26206784db0",
        identity: "skills.ts#parseSkillMarkdown[CallExpression]@1",
        location: {
          file: "skills.ts",
          line: 174,
          column: 18,
        },
        reason:
          "Existing boundary validation call awaiting explicit decoder ownership registration.",
      },
    ],
    "architecture/no-rich-unknown-predicate": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-rich-unknown-predicate|identity=runtime-utils.ts%23isRecord%5BFunctionDeclaration%5D%401|sha256=b8a7c23bdaee85c0cd843da6ca14b4b78321515302617892c2728342489dc541",
        identity: "runtime-utils.ts#isRecord[FunctionDeclaration]@1",
        location: {
          file: "runtime-utils.ts",
          line: 1,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-rich-unknown-predicate|identity=custom-commands.ts%23isValidCustomCommandResult%5BFunctionDeclaration%5D%401|sha256=8296abaf0a83ff95b193d87a5d4eafe34ebb8c845ee1640825affbe08a04a470",
        identity: "custom-commands.ts#isValidCustomCommandResult[FunctionDeclaration]@1",
        location: {
          file: "custom-commands.ts",
          line: 162,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-rich-unknown-predicate|identity=model-message-provider-options.ts%23isOpenAICompactionPart%5BFunctionDeclaration%5D%401|sha256=5bf1e798867f20e4b9cbbb50913a4b977b6fc30767ffa54ce8d4e218378f6c27",
        identity: "model-message-provider-options.ts#isOpenAICompactionPart[FunctionDeclaration]@1",
        location: {
          file: "model-message-provider-options.ts",
          line: 26,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-rich-unknown-predicate|identity=tool-call-input-normalization.ts%23isPlainObject%5BFunctionDeclaration%5D%401|sha256=102a8b71c18c07ec19318fa883afe271c25e90ca53de45eaf65a22d0a0ed4bd2",
        identity: "tool-call-input-normalization.ts#isPlainObject[FunctionDeclaration]@1",
        location: {
          file: "tool-call-input-normalization.ts",
          line: 3,
          column: 1,
        },
        reason:
          "Existing rich unknown predicate awaiting schema decoding or exact capability registration.",
      },
    ],
    "architecture/no-domain-unknown": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=runtime-utils.ts%23isRecord%5BParameter%5D%401|sha256=4dde5834cff3156ca4554207d4f1471c05de97eaa6c8530ff85538ad62540cdb",
        identity: "runtime-utils.ts#isRecord[Parameter]@1",
        location: {
          file: "runtime-utils.ts",
          line: 1,
          column: 26,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=runtime-utils.ts%23errorMessage%5BParameter%5D%401|sha256=91cc16c7d876216be4ebfa914fb118aeed6647c5aed513f787d39eb0ff2fa123",
        identity: "runtime-utils.ts#errorMessage[Parameter]@1",
        location: {
          file: "runtime-utils.ts",
          line: 5,
          column: 30,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=runtime-utils.ts%23errorCode%5BParameter%5D%401|sha256=73f9103bd2e4a14e373ed2caf92bcf6fa86d8f1088ec0adc9853b8ee6519ab4d",
        identity: "runtime-utils.ts#errorCode[Parameter]@1",
        location: {
          file: "runtime-utils.ts",
          line: 9,
          column: 27,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=ai-error.ts%23readString%5BParameter%5D%401|sha256=5e892f36f81ee5d1ef0786a721d0a70a3dc78ac59908f26fbea214826b6de0fb",
        identity: "ai-error.ts#readString[Parameter]@1",
        location: {
          file: "ai-error.ts",
          line: 65,
          column: 21,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=ai-error.ts%23readStringOrNumber%5BParameter%5D%401|sha256=97f2c5f2f529dfc9a3d69a5e048801dffbf1683160a244b6c17e6b051d634fad",
        identity: "ai-error.ts#readStringOrNumber[Parameter]@1",
        location: {
          file: "ai-error.ts",
          line: 69,
          column: 29,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=ai-error.ts%23parseProviderErrorDetails%5BParameter%5D%401|sha256=9104ac21a26993e8096a11e6f7e57c26303f0a1cac59e887e24659af1e99a3f0",
        identity: "ai-error.ts#parseProviderErrorDetails[Parameter]@1",
        location: {
          file: "ai-error.ts",
          line: 74,
          column: 36,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=ai-error.ts%23locateAiErrors%5BParameter%5D%401|sha256=05118ef50a6e04e6a9af25372ac39e57b8cf9c25581c46af93945a9ab8596e95",
        identity: "ai-error.ts#locateAiErrors[Parameter]@1",
        location: {
          file: "ai-error.ts",
          line: 99,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=ai-error.ts%23extractAiErrorLogDetails%5BParameter%5D%401|sha256=3b62d711289ba31ca3cd209418da3c436f9570f44d02c8c93884384dabb8ec28",
        identity: "ai-error.ts#extractAiErrorLogDetails[Parameter]@1",
        location: {
          file: "ai-error.ts",
          line: 140,
          column: 42,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=codex-oauth.ts%23startCodexOAuthLogin%5BParameter%5D%401|sha256=930b7407128a745887257a6115edab2cda0236f8dc13a2259b52a112ed6064e5",
        identity: "codex-oauth.ts#startCodexOAuthLogin[Parameter]@1",
        location: {
          file: "codex-oauth.ts",
          line: 373,
          column: 22,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=codex-oauth.ts%23startCodexOAuthLogin.fail%5BParameter%5D%401|sha256=eac1613730891a25cfabdd974c9e13b89f170e5123d1b35c5aa215ec3f036438",
        identity: "codex-oauth.ts#startCodexOAuthLogin.fail[Parameter]@1",
        location: {
          file: "codex-oauth.ts",
          line: 385,
          column: 17,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=logging.ts%23isPrimitive%5BParameter%5D%401|sha256=44c44bfb160fca817249432dad4a9e2e0664565ad6bdead90a72b9dc5a46c8e9",
        identity: "logging.ts#isPrimitive[Parameter]@1",
        location: {
          file: "logging.ts",
          line: 127,
          column: 22,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=logging.ts%23safeJsonStringify%5BParameter%5D%401|sha256=f722589ee2c0091e2070a23af3d4164899dfaf870abaa76b1050a29798db4d99",
        identity: "logging.ts#safeJsonStringify[Parameter]@1",
        location: {
          file: "logging.ts",
          line: 141,
          column: 28,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=logging.ts%23addNormalizedArgFields%5BParameter%5D%401|sha256=4812503119becbac74b473a33f7499cb1cc59442c76df769005f1128ce927277",
        identity: "logging.ts#addNormalizedArgFields[Parameter]@1",
        location: {
          file: "logging.ts",
          line: 152,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=logging.ts%23normalizeRecordForOpenObserve%5BParameter%5D%401|sha256=2516fad3d13bf6e1700d7ff4ca14f846b674421df2e227d4afbfcca5a67e99f6",
        identity: "logging.ts#normalizeRecordForOpenObserve[Parameter]@1",
        location: {
          file: "logging.ts",
          line: 193,
          column: 40,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=logging.ts%23MirroredLogger.log%5BParameter%5D%401|sha256=6da4b9a21ae6824c6a7eb1301c316d8c57e9074326d23192d3a0c7b3d385fc58",
        identity: "logging.ts#MirroredLogger.log[Parameter]@1",
        location: {
          file: "logging.ts",
          line: 383,
          column: 33,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=logging.ts%23MirroredLogger.logDebug%5BParameter%5D%401|sha256=2a4b154cde76dbf4ef0ebeba9352f3682f2f6eb30f13dabcd91216bc82b2e32d",
        identity: "logging.ts#MirroredLogger.logDebug[Parameter]@1",
        location: {
          file: "logging.ts",
          line: 394,
          column: 21,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=logging.ts%23MirroredLogger.logInfo%5BParameter%5D%401|sha256=6f60da4590daaaf677c296285a48c71747199f8cc7ec13397506d7c8ef21acc6",
        identity: "logging.ts#MirroredLogger.logInfo[Parameter]@1",
        location: {
          file: "logging.ts",
          line: 399,
          column: 20,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=logging.ts%23MirroredLogger.logWarn%5BParameter%5D%401|sha256=37b00bfe215729b20a58c3903fbde48da39f6c4922e76272e66cf7706af54962",
        identity: "logging.ts#MirroredLogger.logWarn[Parameter]@1",
        location: {
          file: "logging.ts",
          line: 404,
          column: 20,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=logging.ts%23MirroredLogger.logError%5BParameter%5D%401|sha256=621b2a8e7416b11edf5f211da1d975d9ce1e4164073053c3ca55d97ecc244d78",
        identity: "logging.ts#MirroredLogger.logError[Parameter]@1",
        location: {
          file: "logging.ts",
          line: 409,
          column: 21,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=logging.ts%23MirroredLogger.logFatal%5BParameter%5D%401|sha256=064fed63806de1cedc2e01d24576862134f6127f738dd3625188c862116d770a",
        identity: "logging.ts#MirroredLogger.logFatal[Parameter]@1",
        location: {
          file: "logging.ts",
          line: 414,
          column: 21,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=logging.ts%23MirroredLogger.debug%5BParameter%5D%401|sha256=8b27b56dc1bc084200c018dfff6286e380cea99b672414e77c9e7e8b8150c78f",
        identity: "logging.ts#MirroredLogger.debug[Parameter]@1",
        location: {
          file: "logging.ts",
          line: 419,
          column: 18,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=logging.ts%23MirroredLogger.info%5BParameter%5D%401|sha256=14838c2ed8f7bf944a9c415af4f9761656a0b38578051a72a8d6459418c40e35",
        identity: "logging.ts#MirroredLogger.info[Parameter]@1",
        location: {
          file: "logging.ts",
          line: 424,
          column: 17,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=logging.ts%23MirroredLogger.warn%5BParameter%5D%401|sha256=87b2fd7bb2b181d03596316f809a6bb61fc691acf550de6ff477cc7762f86afe",
        identity: "logging.ts#MirroredLogger.warn[Parameter]@1",
        location: {
          file: "logging.ts",
          line: 429,
          column: 17,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=logging.ts%23MirroredLogger.error%5BParameter%5D%401|sha256=98adfc814722b7cdbf869d01ed81f015538a284d1d0c6d8385c41b92c6bd8e74",
        identity: "logging.ts#MirroredLogger.error[Parameter]@1",
        location: {
          file: "logging.ts",
          line: 434,
          column: 18,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=logging.ts%23MirroredLogger.fatal%5BParameter%5D%401|sha256=77443e789fe4e95435f4d94c80ab3e28a4cb7c7a0737963f5a429554193e9ce4",
        identity: "logging.ts#MirroredLogger.fatal[Parameter]@1",
        location: {
          file: "logging.ts",
          line: 439,
          column: 18,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=model-capability.ts%23asRecord%5BParameter%5D%401|sha256=1de58f6ab1dd944f858a15946224114752484677d27d67f17ff37ce3451bd471",
        identity: "model-capability.ts#asRecord[Parameter]@1",
        location: {
          file: "model-capability.ts",
          line: 147,
          column: 19,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=model-provider-option-validation.ts%23editDistance.%3Ccallback%3E%5BParameter%5D%401|sha256=ce041ff094bedbd659763aef64f7b2f5f4d07adff971df00e95d38b8b776851e",
        identity: "model-provider-option-validation.ts#editDistance.<callback>[Parameter]@1",
        location: {
          file: "model-provider-option-validation.ts",
          line: 74,
          column: 56,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=core-config%2Funknown-keys.ts%23collectUnknownConfigKeyPathsInto%5BParameter%5D%401|sha256=2315f468239119a3e3f6157789acabdfba5ebed7754e1fc35469ced85009ca9a",
        identity: "core-config/unknown-keys.ts#collectUnknownConfigKeyPathsInto[Parameter]@1",
        location: {
          file: "core-config/unknown-keys.ts",
          line: 24,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=core-config%2Funknown-keys.ts%23collectUnknownConfigKeyPathsInto%5BParameter%5D%401|sha256=e1dc944048844b975c7a83ec0c5e53df7cc4ae861b19af40b25be5488f6ff220",
        identity: "core-config/unknown-keys.ts#collectUnknownConfigKeyPathsInto[Parameter]@1",
        location: {
          file: "core-config/unknown-keys.ts",
          line: 25,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=core-config%2Funknown-keys.ts%23collectUnknownConfigKeyPaths%5BParameter%5D%401|sha256=b7a13c604fcbd9056a7b7f0f18647d90462f3764be1b4dc26890cfb0ce6bc094",
        identity: "core-config/unknown-keys.ts#collectUnknownConfigKeyPaths[Parameter]@1",
        location: {
          file: "core-config/unknown-keys.ts",
          line: 65,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=core-config%2Funknown-keys.ts%23collectUnknownConfigKeyPaths%5BParameter%5D%401|sha256=e0ca7592a0670ac7d77947b4829bad433ecbbc37b7b7d265ebb09594f017b7b2",
        identity: "core-config/unknown-keys.ts#collectUnknownConfigKeyPaths[Parameter]@1",
        location: {
          file: "core-config/unknown-keys.ts",
          line: 66,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=core-config%2Fv1.ts%23%3Ccallback%3E%5BParameter%5D%401|sha256=a0ed93560d2e99cab0ee2ce162f571a9e70c5a283a6eea369d9e1d6fcc742132",
        identity: "core-config/v1.ts#<callback>[Parameter]@1",
        location: {
          file: "core-config/v1.ts",
          line: 258,
          column: 4,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=core-config%2Fv1.ts%23%3Ccallback%3E%5BParameter%5D%402|sha256=5637508e5732dd2f3095b12811401e44540ce098d374737ed042ae1a016a4813",
        identity: "core-config/v1.ts#<callback>[Parameter]@2",
        location: {
          file: "core-config/v1.ts",
          line: 284,
          column: 6,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=core-config%2Fv1.ts%23parseCoreConfigV1%5BParameter%5D%401|sha256=33bda40570df9d51d44111dfcb2adcabef37af147949a63d26e07ab8c032dcb8",
        identity: "core-config/v1.ts#parseCoreConfigV1[Parameter]@1",
        location: {
          file: "core-config/v1.ts",
          line: 683,
          column: 35,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=core-config%2Fv1.ts%23parseCoreConfigV1ToUniversal%5BParameter%5D%401|sha256=a368c282a94f3433451d5d114c0a21fc1db5684b3c6d9b3b477d70dca49ac3dd",
        identity: "core-config/v1.ts#parseCoreConfigV1ToUniversal[Parameter]@1",
        location: {
          file: "core-config/v1.ts",
          line: 688,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=friendly-units.ts%23parseFriendlyUnit%5BParameter%5D%401|sha256=b5891ddc4ae356e653ad58c8852c9df50fa3d70f0151c643b769cf21a7acb4c6",
        identity: "friendly-units.ts#parseFriendlyUnit[Parameter]@1",
        location: {
          file: "friendly-units.ts",
          line: 22,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=friendly-units.ts%23parseFriendlyByteSize%5BParameter%5D%401|sha256=544b8e005817a5e329ad8452379174535cd3d4596594f5ffbdd15e9a87e8645d",
        identity: "friendly-units.ts#parseFriendlyByteSize[Parameter]@1",
        location: {
          file: "friendly-units.ts",
          line: 49,
          column: 39,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=friendly-units.ts%23parseFriendlyDurationMs%5BParameter%5D%401|sha256=b079119ed3aecbca42f034da3028a6a7a4afa12367f7288f0162314d2e574eda",
        identity: "friendly-units.ts#parseFriendlyDurationMs[Parameter]@1",
        location: {
          file: "friendly-units.ts",
          line: 53,
          column: 41,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=core-config%2Fv2.ts%23parseCoreConfigV2%5BParameter%5D%401|sha256=5b98c5e975c0a2e01f551a44041b62d9fd8239832d23390d54909518018ff215",
        identity: "core-config/v2.ts#parseCoreConfigV2[Parameter]@1",
        location: {
          file: "core-config/v2.ts",
          line: 647,
          column: 35,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=core-config%2Fv2.ts%23parseCoreConfigV2ToUniversal%5BParameter%5D%401|sha256=b736da61a7cfc745c3c95fe5dbc9a7dc9b115c53f3f721403e8127cc0e449568",
        identity: "core-config/v2.ts#parseCoreConfigV2ToUniversal[Parameter]@1",
        location: {
          file: "core-config/v2.ts",
          line: 652,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=core-config.ts%23readCoreConfigVersion%5BParameter%5D%401|sha256=fe379c0c7b9857e471448ed04e93d991762080b77f9990024cf75bafb4b648f6",
        identity: "core-config.ts#readCoreConfigVersion[Parameter]@1",
        location: {
          file: "core-config.ts",
          line: 168,
          column: 39,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=core-config.ts%23parseCoreConfig%5BParameter%5D%401|sha256=2bfd02545de4650f39d9e004fbb1a5e49b9fe3848503d316b8fcf7c48b435339",
        identity: "core-config.ts#parseCoreConfig[Parameter]@1",
        location: {
          file: "core-config.ts",
          line: 220,
          column: 3,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=custom-commands.ts%23isValidCustomCommandResult%5BParameter%5D%401|sha256=2732da3c63a535ae0b4ab34e155a5f87902fd80a96d3fb48a607d0c9863ea89c",
        identity: "custom-commands.ts#isValidCustomCommandResult[Parameter]@1",
        location: {
          file: "custom-commands.ts",
          line: 162,
          column: 44,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=openai-responses-websocket-fetch.ts%23createOpenAIResponsesWebSocketFetch.websocketFetch.start.onMessage.%3Ccallback%3E%5BParameter%5D%401|sha256=991bc83ede8d3ba24338f09bad4c574b0e1b93da7779e7f20040403b5fee9598",
        identity:
          "openai-responses-websocket-fetch.ts#createOpenAIResponsesWebSocketFetch.websocketFetch.start.onMessage.<callback>[Parameter]@1",
        location: {
          file: "openai-responses-websocket-fetch.ts",
          line: 609,
          column: 23,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=openai-responses-websocket-fetch.ts%23asJsonArray%5BParameter%5D%401|sha256=abef1a0a0b2a58bc06e1a856d8cfddb5d19b5433f703fce0b304c4122e458e53",
        identity: "openai-responses-websocket-fetch.ts#asJsonArray[Parameter]@1",
        location: {
          file: "openai-responses-websocket-fetch.ts",
          line: 1268,
          column: 22,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=openai-responses-websocket-fetch.ts%23asRecord%5BParameter%5D%401|sha256=c4094738d9c602756a797dae7fa3844c805e13c6fd51e7581778b6e6fd236a19",
        identity: "openai-responses-websocket-fetch.ts#asRecord[Parameter]@1",
        location: {
          file: "openai-responses-websocket-fetch.ts",
          line: 1575,
          column: 19,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=openai-responses-websocket-fetch.ts%23readString%5BParameter%5D%401|sha256=56bac52b405d65d26cac9324a0c84ead0193751e757be535e1396fe97ab78707",
        identity: "openai-responses-websocket-fetch.ts#readString[Parameter]@1",
        location: {
          file: "openai-responses-websocket-fetch.ts",
          line: 1583,
          column: 21,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=openai-responses-websocket-fetch.ts%23readNumber%5BParameter%5D%401|sha256=10ad044e10f32dba7cb1cde3809e19ff46cb4eba3978db89251c9a173b0a4e97",
        identity: "openai-responses-websocket-fetch.ts#readNumber[Parameter]@1",
        location: {
          file: "openai-responses-websocket-fetch.ts",
          line: 1587,
          column: 21,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=openai-responses-websocket-fetch.ts%23readHeaderValue%5BParameter%5D%401|sha256=6c79af63d4ae91e2d29ce7e49d4385b4ec5952f7248e03d45ec698adc0148918",
        identity: "openai-responses-websocket-fetch.ts#readHeaderValue[Parameter]@1",
        location: {
          file: "openai-responses-websocket-fetch.ts",
          line: 1684,
          column: 26,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=llm-wire-debug.ts%23redactValue%5BParameter%5D%401|sha256=d3060e52d1f7488ca4685d9717872eefe9c676c88040d377be826980ac924134",
        identity: "llm-wire-debug.ts#redactValue[Parameter]@1",
        location: {
          file: "llm-wire-debug.ts",
          line: 428,
          column: 22,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=server-compaction-request.ts%23prepareServerCompactionRequest.%3Ccallback%3E%5BParameter%5D%401|sha256=bddd3a133b63168edc1da6353c3c92ce192e21dea89f6d2d5d6387837e9c71e0",
        identity:
          "server-compaction-request.ts#prepareServerCompactionRequest.<callback>[Parameter]@1",
        location: {
          file: "server-compaction-request.ts",
          line: 94,
          column: 6,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=model-provider.ts%23decodeCodexRequestBody%5BParameter%5D%401|sha256=d522853bbf46f57330bd75d186f1b17c5df819cab77b877637b93aae4ba709ef",
        identity: "model-provider.ts#decodeCodexRequestBody[Parameter]@1",
        location: {
          file: "model-provider.ts",
          line: 91,
          column: 33,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=model-message-provider-options.ts%23openAIMessagePhase%5BParameter%5D%401|sha256=e4b0d651ab73c300ff8f3bd40e87658f589c8818509a842117af7882efe7b668",
        identity: "model-message-provider-options.ts#openAIMessagePhase[Parameter]@1",
        location: {
          file: "model-message-provider-options.ts",
          line: 21,
          column: 36,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=model-message-provider-options.ts%23isOpenAICompactionPart%5BParameter%5D%401|sha256=825ced132b769d54871322ff0b2ac55600c815d9a2add0c9b41caacef25bf340",
        identity: "model-message-provider-options.ts#isOpenAICompactionPart[Parameter]@1",
        location: {
          file: "model-message-provider-options.ts",
          line: 26,
          column: 40,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=tool-call-input-normalization.ts%23isPlainObject%5BParameter%5D%401|sha256=11415cd976220f4347e533691128e52504f77da662eb94f9542adbaea2d247fa",
        identity: "tool-call-input-normalization.ts#isPlainObject[Parameter]@1",
        location: {
          file: "tool-call-input-normalization.ts",
          line: 3,
          column: 24,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=tool-call-input-normalization.ts%23normalizeToolCallInputValue%5BParameter%5D%401|sha256=f729246bd818f26ee0c74325a75fb9413d0ad6bfcf77c35eb7c73b6aad3095b1",
        identity: "tool-call-input-normalization.ts#normalizeToolCallInputValue[Parameter]@1",
        location: {
          file: "tool-call-input-normalization.ts",
          line: 104,
          column: 45,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-domain-unknown|identity=subagent-profile.ts%23isNativeSubagentProfile%5BParameter%5D%401|sha256=c28cca339ce188a030b0df724cd25e5d0b0c121a950a1b9108a84add47501c95",
        identity: "subagent-profile.ts#isNativeSubagentProfile[Parameter]@1",
        location: {
          file: "subagent-profile.ts",
          line: 11,
          column: 41,
        },
        reason:
          "Existing domain-bearing unknown parameter awaiting boundary decoding or an opaque-value exception.",
      },
    ],
    "architecture/no-unknown-assertion": [
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-unknown-assertion|identity=logging.ts%23hasTestGlobals%5BAsExpression%5D%401|sha256=f773302f636badbc844b70cb0be68a960b9dd31719339777f571588c172c3bdf",
        identity: "logging.ts#hasTestGlobals[AsExpression]@1",
        location: {
          file: "logging.ts",
          line: 17,
          column: 13,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-unknown-assertion|identity=custom-commands.ts%23discoverCustomCommands%5BAsExpression%5D%401|sha256=07717a673dacd66475638240e43acd483c559232ab11ae89c25a8dc2c77db42c",
        identity: "custom-commands.ts#discoverCustomCommands[AsExpression]@1",
        location: {
          file: "custom-commands.ts",
          line: 177,
          column: 23,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-unknown-assertion|identity=openai-responses-websocket-fetch.ts%23stableJsonStringify.%3Ccallback%3E%5BAsExpression%5D%401|sha256=79d12eaace12d5a684718461b900e6ebd81370ea328d1232971071202eed1307",
        identity:
          "openai-responses-websocket-fetch.ts#stableJsonStringify.<callback>[AsExpression]@1",
        location: {
          file: "openai-responses-websocket-fetch.ts",
          line: 1302,
          column: 65,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-unknown-assertion|identity=openai-responses-websocket-fetch.ts%23deepEqualJson%5BAsExpression%5D%401|sha256=3306ed52176a991fb81f741c08016266e4a21ad2b47066c1fa95c29525c401c8",
        identity: "openai-responses-websocket-fetch.ts#deepEqualJson[AsExpression]@1",
        location: {
          file: "openai-responses-websocket-fetch.ts",
          line: 1333,
          column: 11,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-unknown-assertion|identity=openai-responses-websocket-fetch.ts%23deepEqualJson%5BAsExpression%5D%401|sha256=55645083a1c1610cacca113e77deee6e874c7bcc28148fefc58c1df6314fb890",
        identity: "openai-responses-websocket-fetch.ts#deepEqualJson[AsExpression]@1",
        location: {
          file: "openai-responses-websocket-fetch.ts",
          line: 1334,
          column: 11,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
      {
        fingerprint:
          "arch-v2|workspace=packages%2Futils|rule=architecture%2Fno-unknown-assertion|identity=llm-wire-debug.ts%23withLlmWireDebugFetch.%3Ccallback%3E%5BAsExpression%5D%401|sha256=c82c3cdc4d50dc9e00d63d5d3cad84803a585a35ed25b2c0353ff9e333d8fe27",
        identity: "llm-wire-debug.ts#withLlmWireDebugFetch.<callback>[AsExpression]@1",
        location: {
          file: "llm-wire-debug.ts",
          line: 157,
          column: 17,
        },
        reason: "Existing structured assertion from unknown awaiting complete runtime validation.",
      },
    ],
  },
} satisfies ArchitectureBaseline;
