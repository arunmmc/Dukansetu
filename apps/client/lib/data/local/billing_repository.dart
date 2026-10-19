import 'dart:convert';
import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';
import 'app_database.dart';

class DraftLine {
  const DraftLine({required this.name, required this.quantity, required this.unitPrice, this.gstRate = 0});
  final String name;
  final double quantity;
  final double unitPrice;
  final double gstRate;
  double get total => quantity * unitPrice * (1 + gstRate / 100);
}

class SavedInvoice {
  const SavedInvoice(this.id, this.number, this.total, this.due);
  final String id, number;
  final double total, due;
}

class BillingRepository {
  BillingRepository(this.db, {required this.devicePrefix});
  final AppDatabase db;
  final String devicePrefix;
  static const _uuid = Uuid();

  Future<SavedInvoice> createInvoice({required String partyName, String? phone,
    required List<DraftLine> lines, required double paid, required String paymentMode}) async {
    if (lines.isEmpty || lines.any((l) => l.name.trim().isEmpty || l.quantity <= 0 || l.unitPrice < 0)) {
      throw ArgumentError('Add valid invoice items');
    }
    final now = DateTime.now().toUtc();
    final total = lines.fold<double>(0, (sum, line) => sum + line.total);
    if (paid < 0 || paid > total) throw ArgumentError('Paid amount must be between zero and invoice total');
    final invoiceId = _uuid.v4();
    final due = total - paid;
    return db.transaction(() async {
      // Reuse the local customer identity so later bills and balances belong to
      // one ledger account. A phone number is the strongest locally available key.
      final partyQuery = db.select(db.parties)
        ..where((p) => p.deletedAt.isNull() & p.type.equals('CUSTOMER') &
          (phone != null && phone.trim().isNotEmpty ? p.phone.equals(phone.trim()) : p.name.equals(partyName.trim())))
        ..limit(1);
      final existingParty = await partyQuery.getSingleOrNull();
      final partyId = existingParty?.id as String? ?? _uuid.v4();
      final previousBalance = (existingParty?.currentBalance as double?) ?? 0;
      if (existingParty == null) {
        await db.into(db.parties).insert(PartiesCompanion.insert(
          id: partyId, name: partyName.trim(), phone: Value(phone), type: 'CUSTOMER',
          createdAt: now, updatedAt: now, currentBalance: Value(due)));
      } else {
        await (db.update(db.parties)..where((p) => p.id.equals(partyId))).write(
          PartiesCompanion(name: Value(partyName.trim()), phone: Value(phone),
            currentBalance: Value(previousBalance + due), updatedAt: Value(now),
            syncStatus: const Value('PENDING')));
      }
      final number = await _nextInvoiceNumber(now);
      await db.into(db.invoices).insert(InvoicesCompanion.insert(
        id: invoiceId, invoiceNumber: number, partyId: partyId, totalAmount: total,
        paidAmount: paid, dueAmount: due, paymentMode: paymentMode,
        createdAt: now, updatedAt: now, whatsappStatus: const Value('QUEUED'),
        dueDate: Value(due > 0 ? now.add(const Duration(days: 7)) : null)));
      final invoiceItems = <Map<String, Object?>>[];
      for (final line in lines) {
        final productId = _uuid.v4();
        final itemId = _uuid.v4();
        final lineTotal = line.total;
        await db.into(db.products).insert(ProductsCompanion.insert(id: productId, name: line.name.trim(),
          unit: 'PCS', wholesalePrice: line.unitPrice, retailPrice: line.unitPrice,
          purchasePrice: line.unitPrice, createdAt: now, updatedAt: now, stockQuantity: const Value(0)));
        await db.into(db.invoiceItems).insert(InvoiceItemsCompanion.insert(id: itemId,
          invoiceId: invoiceId, productId: productId, quantity: line.quantity, unitPrice: line.unitPrice,
          gstRate: line.gstRate, totalPrice: lineTotal, createdAt: now, updatedAt: now));
        invoiceItems.add({'id': itemId, 'invoice_id': invoiceId, 'product_id': productId,
          'quantity': line.quantity, 'unit_price': line.unitPrice, 'gst_rate': line.gstRate,
          'total_price': lineTotal, 'created_at': now.toIso8601String(), 'updated_at': now.toIso8601String()});
        await _enqueue('product', productId, {'id': productId, 'name': line.name.trim(), 'unit': 'PCS',
          'wholesale_price': line.unitPrice, 'retail_price': line.unitPrice, 'purchase_price': line.unitPrice,
          'min_stock_alert': 0, 'created_at': now.toIso8601String(), 'updated_at': now.toIso8601String()}, now);
      }
      final invoicePayload = {'id': invoiceId, 'invoice_number': number, 'party_id': partyId,
        'total_amount': total, 'paid_amount': paid, 'due_amount': due, 'payment_mode': paymentMode,
        'whatsapp_status': 'QUEUED', 'created_at': now.toIso8601String(),
        'updated_at': now.toIso8601String(), 'due_date': due > 0 ? now.add(const Duration(days: 7)).toIso8601String() : null,
        'items': invoiceItems};
      await _enqueue('invoice', invoiceId, invoicePayload, now);
      await _enqueue('party', partyId, {'id': partyId, 'name': partyName.trim(), 'phone': phone,
        'type': 'CUSTOMER', 'credit_limit': existingParty?.creditLimit ?? 0,
        'current_balance': previousBalance + due,
        'created_at': (existingParty?.createdAt ?? now).toIso8601String(), 'updated_at': now.toIso8601String()}, now);
      return SavedInvoice(invoiceId, number, total, due);
    });
  }

  Future<String> _nextInvoiceNumber(DateTime now) async {
    final year = now.year.toString();
    final key = 'invoice_sequence_$year';
    final row = await (db.select(db.localMetadata)..where((t) => t.key.equals(key))).getSingleOrNull();
    final next = (int.tryParse(row?.value ?? '') ?? 0) + 1;
    await db.into(db.localMetadata).insertOnConflictUpdate(LocalMetadataCompanion.insert(key: key, value: '$next'));
    return '$devicePrefix-$year-${next.toString().padLeft(6, '0')}';
  }

  Future<void> _enqueue(String type, String id, Map<String, Object?> payload, DateTime now) async {
    await db.into(db.outboundSyncQueue).insert(OutboundSyncQueueCompanion.insert(
      id: _uuid.v4(), entityType: type, entityId: id, operation: 'UPSERT',
      payloadJson: jsonEncode(payload), createdAt: now));
  }
}
