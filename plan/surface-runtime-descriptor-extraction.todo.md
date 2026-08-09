# Surface Runtime Descriptor Extraction Todo

Source: `plan/surface-runtime-descriptor-extraction.md`

## Stage 0: Groundwork

- [x] Remove dead adapter capability and authoritative-self-provider contracts.
- [x] Require exact `request_client` headers in all relay-consumed event paths and add focused tests.
- [x] Characterize Discord and GitHub relay finalization behavior with focused tests.
- [x] Make the request router explicitly Discord-owned with a runtime platform invariant.
- [x] Run focused tests, Core/root typechecks, root lint/fmt, and independent review.

## Stage 1: Lifecycle Characterization

- [x] Add registry and runtime lifecycle parity tests.
- [x] Characterize and fix request-router rollback after later subscription startup failures.

## Stage 2: Generic Event Projection

- [x] Extract generic adapter-event projections and add compatibility/consistency tests.

## Stage 3: Descriptor Types And Existing Registrations

- [x] Add the closed descriptor registry and Discord/GitHub factories.

## Stage 4: Runtime Lifecycle Migration

- [x] Drive surface lifecycle and recovery through the descriptor registry.

## Stage 5: Relay Policy Extraction

- [ ] Move protocol-specific relay policy behind descriptor ports.

## Stage 6: Workflow Migration

- [ ] Move workflow progress behavior behind descriptor ports.

## Stage 7: Verification And Documentation

- [ ] Complete repository-wide validation and update project documentation.
