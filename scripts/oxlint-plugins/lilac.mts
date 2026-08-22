import { definePlugin } from "@oxlint/plugins";

import {
  blobStorageSeamRule,
  noExceptionFlowRule,
  noDirectSqliteTransactionRule,
  noInlineAsyncResultCallbackRule,
  noLocalIsRecordRule,
  noPresentationDecoderImportRule,
  noStoreInlineDecodingRule,
} from "./production-syntax.mts";
import { noFixedTestWaitRule } from "./test-waits.mts";

export default definePlugin({
  meta: { name: "lilac" },
  rules: {
    "blob-storage-seam": blobStorageSeamRule,
    "no-exception-flow": noExceptionFlowRule,
    "no-direct-sqlite-transaction": noDirectSqliteTransactionRule,
    "no-fixed-test-wait": noFixedTestWaitRule,
    "no-inline-async-result-callback": noInlineAsyncResultCallbackRule,
    "no-local-is-record": noLocalIsRecordRule,
    "no-presentation-decoder-import": noPresentationDecoderImportRule,
    "no-store-inline-decoding": noStoreInlineDecodingRule,
  },
});
