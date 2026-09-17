import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

// Only `name` is client-mutable. `totalCapacityUsd`/`treasuryVersion` are treasury-owned
// (BUSINESS.md: "Treasury owns Program total capacity"; CLAUDE.md Reconciliation:
// "replace treasury-owned totalCapacityUsd, set treasuryVersion") and must only change
// through the future reconciliation flow, not ordinary client CRUD. `originalCapacity` is
// the as-originated reference value recorded at creation time; nothing in BUSINESS.md
// documents it as client-editable after the fact, so - per CLAUDE.md's instruction to
// "flag the inconsistency rather than silently expanding client authority" - it is
// treated the same conservative way rather than assumed mutable.
export class UpdateProgramDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;
}
