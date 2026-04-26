# bud

Bud-owned protobuf namespace for the gRPC interop spike.

## Purpose

This folder mirrors the production schema namespace style while keeping the Phase 1.5 interop schema isolated from the production `proto/` tree.

## Files

No direct schema files live at this level.

## Subfolders

- [interop/](./interop/interop.spec.md) - Interop-only services and messages for runtime validation.

## Dependencies

- [../proto.spec.md](../proto.spec.md) - parent spike proto spec.

## TODOs / Technical Debt

None.

---

*Referenced by: [../proto.spec.md](../proto.spec.md)*
