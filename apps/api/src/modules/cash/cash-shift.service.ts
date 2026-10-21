import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AuditAction,
  CashMovementType,
  CashShiftStatus,
  type CashMovementDto,
  type CashRegisterDto,
  type CashShiftDetailDto,
  type CashShiftDto,
  type CashShiftSummaryDto,
} from '@erp/shared';
import { Prisma } from '@erp/database';
import { AppError } from '../../common/errors/app-error';
import type { AuthenticatedUser, RequestContext } from '../../common/auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { parseMoneyInput } from '../products/product-mapper';
import { CashMovementInputDto, CloseCashShiftDto, OpenCashShiftDto } from './dto/cash.dto';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;

export const DEFAULT_CASH_REGISTER_CODE = 'MAIN';
const TX = { maxWait: 10_000, timeout: 30_000 } as const;

const shiftInclude = {
  cashRegister: { select: { code: true, name: true } },
  openedBy: { select: { name: true } },
  closedBy: { select: { name: true } },
} satisfies Prisma.CashShiftInclude;

type ShiftRow = Prisma.CashShiftGetPayload<{ include: typeof shiftInclude }>;

const ZERO = new Prisma.Decimal(0);

function err(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
  status: number = HttpStatus.BAD_REQUEST,
): AppError {
  return new AppError(code, message, details, status);
}

/** Signed effect of a movement on drawer cash. */
export function signedMovementAmount(type: CashMovementType, amount: Prisma.Decimal): Prisma.Decimal {
  switch (type) {
    case CashMovementType.SALE_IN:
    case CashMovementType.FLOAT_IN:
      return amount;
    case CashMovementType.REFUND_OUT:
    case CashMovementType.FLOAT_OUT:
      return amount.negated();
    case CashMovementType.ADJUSTMENT:
      return amount; // signed as stored
    default:
      return ZERO;
  }
}

@Injectable()
export class CashShiftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async listRegisters(): Promise<CashRegisterDto[]> {
    await this.ensureDefaultRegister(this.prisma);
    const registers = await this.prisma.cashRegister.findMany({
      where: { isActive: true },
      orderBy: { code: 'asc' },
    });
    const open = await this.prisma.cashShift.findMany({
      where: { status: CashShiftStatus.OPEN, cashRegisterId: { in: registers.map((r) => r.id) } },
      include: shiftInclude,
    });
    const byRegister = new Map(open.map((s) => [s.cashRegisterId, s] as const));
    return registers.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      isActive: r.isActive,
      openShift: byRegister.has(r.id) ? this.toShiftDto(byRegister.get(r.id)!) : null,
    }));
  }

  /** Current OPEN shift of the register (default MAIN), or null. */
  async getCurrent(cashRegisterId?: string): Promise<CashShiftDto | null> {
    const row = await this.prisma.cashShift.findFirst({
      where: {
        status: CashShiftStatus.OPEN,
        cashRegister: cashRegisterId
          ? { id: cashRegisterId }
          : { code: DEFAULT_CASH_REGISTER_CODE },
      },
      include: shiftInclude,
      orderBy: { openedAt: 'desc' },
    });
    return row ? this.toShiftDto(row) : null;
  }

  async list(status?: CashShiftStatus): Promise<CashShiftDto[]> {
    const rows = await this.prisma.cashShift.findMany({
      where: status ? { status } : undefined,
      include: shiftInclude,
      orderBy: { openedAt: 'desc' },
      take: 100,
    });
    return rows.map((r) => this.toShiftDto(r));
  }

  async getById(id: string): Promise<CashShiftDetailDto> {
    const row = await this.prisma.cashShift.findUnique({ where: { id }, include: shiftInclude });
    if (!row) throw this.notFound();
    return this.toDetail(this.prisma, row);
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  async open(
    actor: AuthenticatedUser,
    dto: OpenCashShiftDto,
    context: RequestContext = {},
  ): Promise<CashShiftDetailDto> {
    const openingFloat = this.money(dto.openingFloat, 'openingFloat', { allowZero: true });
    return this.prisma.$transaction(async (tx) => {
      const register = dto.cashRegisterId
        ? await tx.cashRegister.findUnique({ where: { id: dto.cashRegisterId } })
        : await this.ensureDefaultRegister(tx);
      if (!register || !register.isActive) {
        throw err('CASH_REGISTER_NOT_FOUND', 'Касса не найдена', {}, HttpStatus.NOT_FOUND);
      }
      // Serialize concurrent opens on the same register (no partial unique index in schema).
      await tx.$queryRaw`SELECT id FROM cash_registers WHERE id = ${register.id} FOR UPDATE`;
      const existing = await tx.cashShift.findFirst({
        where: { cashRegisterId: register.id, status: CashShiftStatus.OPEN },
        select: { id: true },
      });
      if (existing) {
        throw err(
          'CASH_SHIFT_ALREADY_OPEN',
          'На этой кассе уже есть открытая смена',
          { cashShiftId: existing.id, cashRegisterId: register.id },
          HttpStatus.CONFLICT,
        );
      }
      const created = await tx.cashShift.create({
        data: {
          cashRegisterId: register.id,
          status: CashShiftStatus.OPEN,
          openedByUserId: actor.id,
          openingFloat,
          note: dto.note?.trim() || null,
        },
        include: shiftInclude,
      });
      await this.audit.log({
        action: AuditAction.CASH_SHIFT_OPENED,
        actorUserId: actor.id,
        entityType: 'CashShift',
        entityId: created.id,
        after: { cashRegisterId: register.id, openingFloat: openingFloat.toFixed(2) },
        metadata: { cashRegisterCode: register.code },
        context,
        tx,
      });
      return this.toDetail(tx, created);
    }, TX);
  }

  async close(
    actor: AuthenticatedUser,
    id: string,
    dto: CloseCashShiftDto,
    context: RequestContext = {},
  ): Promise<CashShiftDetailDto> {
    const countedCash = this.money(dto.countedCash, 'countedCash', { allowZero: true });
    return this.prisma.$transaction(async (tx) => {
      const shift = await this.lockShift(tx, id, 'UPDATE');
      if (shift.status !== CashShiftStatus.OPEN) {
        throw err(
          'CASH_SHIFT_CLOSED',
          'Смена уже закрыта',
          { cashShiftId: id },
          HttpStatus.CONFLICT,
        );
      }
      const summary = await this.computeSummary(tx, shift.id, shift.openingFloat);
      const expected = new Prisma.Decimal(summary.expectedCash);
      const discrepancy = countedCash.minus(expected);
      const closed = await tx.cashShift.update({
        where: { id },
        data: {
          status: CashShiftStatus.CLOSED,
          closedByUserId: actor.id,
          closedAt: new Date(),
          expectedCash: expected,
          countedCash,
          discrepancy,
          note: dto.note?.trim() ? dto.note.trim() : shift.note,
        },
        include: shiftInclude,
      });
      await this.audit.log({
        action: AuditAction.CASH_SHIFT_CLOSED,
        actorUserId: actor.id,
        entityType: 'CashShift',
        entityId: id,
        after: {
          expectedCash: expected.toFixed(2),
          countedCash: countedCash.toFixed(2),
          discrepancy: discrepancy.toFixed(2),
        },
        context,
        tx,
      });
      return this.toDetail(tx, closed);
    }, TX);
  }

  async addMovement(
    actor: AuthenticatedUser,
    id: string,
    dto: CashMovementInputDto,
    context: RequestContext = {},
  ): Promise<CashShiftDetailDto> {
    const type = dto.type;
    if (
      type !== CashMovementType.FLOAT_IN &&
      type !== CashMovementType.FLOAT_OUT &&
      type !== CashMovementType.ADJUSTMENT
    ) {
      throw err(
        'CASH_MOVEMENT_TYPE_NOT_ALLOWED',
        'Вручную можно добавить только внесение, изъятие или корректировку',
      );
    }
    const note = dto.note.trim();
    if (!note) throw err('CASH_MOVEMENT_NOTE_REQUIRED', 'Укажите комментарий');

    let amount: Prisma.Decimal;
    try {
      amount = new Prisma.Decimal(dto.amount);
    } catch {
      throw err('CASH_INVALID_MONEY', 'Некорректная сумма');
    }
    if (amount.isZero()) throw err('CASH_INVALID_MONEY', 'Сумма должна быть ненулевой');
    if (type !== CashMovementType.ADJUSTMENT && amount.isNegative()) {
      throw err('CASH_INVALID_MONEY', 'Сумма должна быть положительной');
    }

    return this.prisma.$transaction(async (tx) => {
      const shift = await this.lockShift(tx, id, 'UPDATE');
      if (shift.status !== CashShiftStatus.OPEN) {
        throw err('CASH_SHIFT_CLOSED', 'Смена закрыта', { cashShiftId: id }, HttpStatus.CONFLICT);
      }
      const before = await this.computeSummary(tx, id, shift.openingFloat);
      const next = new Prisma.Decimal(before.expectedCash).plus(signedMovementAmount(type, amount));
      if (next.isNegative()) {
        throw err(
          'CASH_INSUFFICIENT',
          'В кассе недостаточно наличных для этой операции',
          { expectedCash: before.expectedCash },
          HttpStatus.CONFLICT,
        );
      }
      const movement = await tx.cashMovement.create({
        data: { cashShiftId: id, type, amount, note, createdByUserId: actor.id },
      });
      await this.audit.log({
        action: AuditAction.CASH_MOVEMENT_CREATED,
        actorUserId: actor.id,
        entityType: 'CashMovement',
        entityId: movement.id,
        after: { cashShiftId: id, type, amount: amount.toFixed(2) },
        metadata: { note },
        context,
        tx,
      });
      const fresh = await tx.cashShift.findUniqueOrThrow({
        where: { id },
        include: shiftInclude,
      });
      return this.toDetail(tx, fresh);
    }, TX);
  }

  // ---------------------------------------------------------------------------
  // Helpers used by PaymentsService (same transaction)
  // ---------------------------------------------------------------------------

  /**
   * Resolve + share-lock an OPEN shift for a cash payment. Close/movements take FOR UPDATE,
   * so a payment can never be written into a shift that is closing.
   */
  async lockOpenShiftForPayment(tx: Tx, cashShiftId?: string | null): Promise<{ id: string }> {
    let targetId = cashShiftId ?? null;
    if (!targetId) {
      const found = await tx.cashShift.findFirst({
        where: { status: CashShiftStatus.OPEN, cashRegister: { code: DEFAULT_CASH_REGISTER_CODE } },
        select: { id: true },
        orderBy: { openedAt: 'desc' },
      });
      targetId = found?.id ?? null;
    }
    if (!targetId) {
      throw err(
        'CASH_SHIFT_REQUIRED',
        'Для приёма наличных откройте кассовую смену',
        {},
        HttpStatus.CONFLICT,
      );
    }
    const shift = await this.lockShift(tx, targetId, 'SHARE');
    if (shift.status !== CashShiftStatus.OPEN) {
      throw err(
        'CASH_SHIFT_REQUIRED',
        'Кассовая смена закрыта. Откройте новую смену.',
        { cashShiftId: targetId },
        HttpStatus.CONFLICT,
      );
    }
    return { id: shift.id };
  }

  async recordPaymentMovement(
    tx: Tx,
    input: {
      cashShiftId: string;
      type: CashMovementType.SALE_IN | CashMovementType.REFUND_OUT;
      amount: Prisma.Decimal;
      paymentId: string;
      createdByUserId: string;
      note?: string | null;
    },
  ): Promise<void> {
    await tx.cashMovement.create({
      data: {
        cashShiftId: input.cashShiftId,
        type: input.type,
        amount: input.amount,
        paymentId: input.paymentId,
        note: input.note ?? null,
        createdByUserId: input.createdByUserId,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async ensureDefaultRegister(db: Db) {
    const existing = await db.cashRegister.findUnique({
      where: { code: DEFAULT_CASH_REGISTER_CODE },
    });
    if (existing) return existing;
    return db.cashRegister.upsert({
      where: { code: DEFAULT_CASH_REGISTER_CODE },
      create: { code: DEFAULT_CASH_REGISTER_CODE, name: 'Основная касса' },
      update: {},
    });
  }

  private async lockShift(tx: Tx, id: string, mode: 'UPDATE' | 'SHARE') {
    const rows =
      mode === 'UPDATE'
        ? await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM cash_shifts WHERE id = ${id} FOR UPDATE`
        : await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM cash_shifts WHERE id = ${id} FOR SHARE`;
    if (!rows[0]) throw this.notFound();
    // Re-read after the lock (READ COMMITTED sees the latest committed state).
    return tx.cashShift.findUniqueOrThrow({ where: { id } });
  }

  private async computeSummary(
    db: Db,
    cashShiftId: string,
    openingFloat: Prisma.Decimal,
  ): Promise<CashShiftSummaryDto> {
    const groups = await db.cashMovement.groupBy({
      by: ['type'],
      where: { cashShiftId },
      _sum: { amount: true },
    });
    const sum = (t: CashMovementType) =>
      groups.find((g) => g.type === t)?._sum.amount ?? ZERO;
    const saleIn = sum(CashMovementType.SALE_IN);
    const refundOut = sum(CashMovementType.REFUND_OUT);
    const floatIn = sum(CashMovementType.FLOAT_IN);
    const floatOut = sum(CashMovementType.FLOAT_OUT);
    const adjustments = sum(CashMovementType.ADJUSTMENT);
    const expected = openingFloat
      .plus(saleIn)
      .minus(refundOut)
      .plus(floatIn)
      .minus(floatOut)
      .plus(adjustments);
    return {
      openingFloat: openingFloat.toFixed(2),
      saleIn: saleIn.toFixed(2),
      refundOut: refundOut.toFixed(2),
      floatIn: floatIn.toFixed(2),
      floatOut: floatOut.toFixed(2),
      adjustments: adjustments.toFixed(2),
      expectedCash: expected.toFixed(2),
    };
  }

  private async toDetail(db: Db, row: ShiftRow): Promise<CashShiftDetailDto> {
    const [summary, movements] = await Promise.all([
      this.computeSummary(db, row.id, row.openingFloat),
      db.cashMovement.findMany({
        where: { cashShiftId: row.id },
        include: { createdBy: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const base = this.toShiftDto(row);
    return {
      ...base,
      // Live expected value while the shift is OPEN.
      expectedCash: base.expectedCash ?? summary.expectedCash,
      summary,
      movements: movements.map<CashMovementDto>((m) => ({
        id: m.id,
        cashShiftId: m.cashShiftId,
        type: m.type as CashMovementType,
        amount: m.amount.toFixed(2),
        paymentId: m.paymentId,
        note: m.note,
        createdByName: m.createdBy.name,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  private toShiftDto(row: ShiftRow): CashShiftDto {
    return {
      id: row.id,
      cashRegisterId: row.cashRegisterId,
      cashRegisterCode: row.cashRegister.code,
      cashRegisterName: row.cashRegister.name,
      status: row.status as CashShiftStatus,
      openingFloat: row.openingFloat.toFixed(2),
      expectedCash: row.expectedCash?.toFixed(2) ?? null,
      countedCash: row.countedCash?.toFixed(2) ?? null,
      discrepancy: row.discrepancy?.toFixed(2) ?? null,
      openedAt: row.openedAt.toISOString(),
      closedAt: row.closedAt?.toISOString() ?? null,
      openedByName: row.openedBy.name,
      closedByName: row.closedBy?.name ?? null,
      note: row.note,
    };
  }

  private money(raw: string, field: string, opts: { allowZero?: boolean } = {}): Prisma.Decimal {
    let v: Prisma.Decimal | null;
    try {
      v = parseMoneyInput(raw);
    } catch {
      throw err('CASH_INVALID_MONEY', 'Некорректная сумма', { field });
    }
    if (!v || (!opts.allowZero && v.isZero())) {
      throw err('CASH_INVALID_MONEY', 'Некорректная сумма', { field });
    }
    return v;
  }

  private notFound(): AppError {
    return err('CASH_SHIFT_NOT_FOUND', 'Смена не найдена', {}, HttpStatus.NOT_FOUND);
  }
}
