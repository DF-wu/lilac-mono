import { definePlugin } from "@oxlint/plugins";

import {
  noExceptionFlowRule,
  noInlineAsyncResultCallbackRule,
  noLocalIsRecordRule,
  noPresentationDecoderImportRule,
} from "./production-syntax.mts";
import { noFixedTestWaitRule } from "./test-waits.mts";

export default definePlugin({
  meta: { name: "lilac" },
  rules: {
    "no-exception-flow": noExceptionFlowRule,
    "no-fixed-test-wait": noFixedTestWaitRule,
    "no-inline-async-result-callback": noInlineAsyncResultCallbackRule,
    "no-local-is-record": noLocalIsRecordRule,
    "no-presentation-decoder-import": noPresentationDecoderImportRule,
  },
});
