import 'dart:convert';
import 'dart:async';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:drift/drift.dart';
import 'package:http/http.dart' as http;
import '../local/app_database.dart';

class SyncWorker {
  SyncWorker({required this.db, required this.baseUrl, required this.syncToken});
  final AppDatabase db;
  final String baseUrl, syncToken;
  bool _running = false;

  Stream<void> watchConnectivity() => Connectivity().onConnectivityChanged
      .where((states) => states.any((s) => s != ConnectivityResult.none))
      .asyncMap((_) => syncOnce());

  Future<void> syncOnce() async {
    if (_running) return;
    _running = true;
    var batchSucceeded = false;
    try {
      final pending = await (db.select(db.outboundSyncQueue)
            ..orderBy([(t) => OrderingTerm.asc(t.createdAt)])
            ..limit(100)).get();
      final lastRow = await (db.select(db.localMetadata)..where((t) => t.key.equals('last_synced_at'))).getSingleOrNull();
      final response = await http.post(Uri.parse('$baseUrl/api/v1/sync/push'),
        headers: {'content-type': 'application/json', 'authorization': 'Bearer $syncToken'},
        body: jsonEncode({'mutations': pending.map((m) => {'id': m.id, 'entity_type': m.entityType,
          'entity_id': m.entityId, 'operation': m.operation, 'payload': jsonDecode(m.payloadJson),
          'created_at': m.createdAt.toUtc().toIso8601String()}).toList(),
          'last_synced_at': lastRow?.value}),
        ).timeout(const Duration(seconds: 20));
      if (response.statusCode < 200 || response.statusCode >= 300) throw Exception('Sync returned ${response.statusCode}');
      final decoded = jsonDecode(response.body) as Map<String, dynamic>;
      final acknowledged = (decoded['acknowledged_ids'] as List).cast<String>();
      await db.transaction(() async {
        final ackedRows = pending.where((m) => acknowledged.contains(m.id));
        for (final mutation in ackedRows) {
          switch (mutation.entityType) {
            case 'party': await (db.update(db.parties)..where((t) => t.id.equals(mutation.entityId))).write(const PartiesCompanion(syncStatus: Value('SYNCED'))); break;
            case 'product': await (db.update(db.products)..where((t) => t.id.equals(mutation.entityId))).write(const ProductsCompanion(syncStatus: Value('SYNCED'))); break;
            case 'invoice':
              await (db.update(db.invoices)..where((t) => t.id.equals(mutation.entityId))).write(const InvoicesCompanion(syncStatus: Value('SYNCED')));
              await (db.update(db.invoiceItems)..where((t) => t.invoiceId.equals(mutation.entityId))).write(const InvoiceItemsCompanion(syncStatus: Value('SYNCED')));
              break;
            case 'ledger_transaction': await (db.update(db.ledgerTransactions)..where((t) => t.id.equals(mutation.entityId))).write(const LedgerTransactionsCompanion(syncStatus: Value('SYNCED'))); break;
            case 'stock_movement': await (db.update(db.stockMovements)..where((t) => t.id.equals(mutation.entityId))).write(const StockMovementsCompanion(syncStatus: Value('SYNCED'))); break;
          }
        }
        await (db.delete(db.outboundSyncQueue)..where((t) => t.id.isIn(acknowledged))).go();
        await _applyDeltas((decoded['deltas'] as List).cast<Map<String, dynamic>>());
        await db.into(db.localMetadata).insertOnConflictUpdate(LocalMetadataCompanion.insert(
          key: 'last_synced_at', value: decoded['server_time'] as String));
      });
      batchSucceeded = true;
    } catch (error) {
      // Keep failed mutations durable and retry on the next connectivity event/backoff tick.
      final pending = await (db.select(db.outboundSyncQueue)..limit(100)).get();
      for (final mutation in pending) {
        await (db.update(db.outboundSyncQueue)..where((t) => t.id.equals(mutation.id))).write(
          OutboundSyncQueueCompanion(attempts: Value(mutation.attempts + 1), lastError: Value('$error')));
        switch (mutation.entityType) {
          case 'party': await (db.update(db.parties)..where((t) => t.id.equals(mutation.entityId))).write(const PartiesCompanion(syncStatus: Value('FAILED'))); break;
          case 'product': await (db.update(db.products)..where((t) => t.id.equals(mutation.entityId))).write(const ProductsCompanion(syncStatus: Value('FAILED'))); break;
          case 'invoice': await (db.update(db.invoices)..where((t) => t.id.equals(mutation.entityId))).write(const InvoicesCompanion(syncStatus: Value('FAILED'))); break;
          case 'ledger_transaction': await (db.update(db.ledgerTransactions)..where((t) => t.id.equals(mutation.entityId))).write(const LedgerTransactionsCompanion(syncStatus: Value('FAILED'))); break;
          case 'stock_movement': await (db.update(db.stockMovements)..where((t) => t.id.equals(mutation.entityId))).write(const StockMovementsCompanion(syncStatus: Value('FAILED'))); break;
        }
      }
    } finally { _running = false; }
    final remaining = await (db.select(db.outboundSyncQueue)..limit(100)).get();
    if (batchSucceeded && remaining.length == 100) unawaited(syncOnce());
  }

  Future<void> _applyDeltas(List<Map<String, dynamic>> deltas) async {
    const priority = {'party': 0, 'product': 1, 'invoice': 2, 'ledger_transaction': 3, 'stock_movement': 3};
    deltas.sort((a,b) => (priority[a['entity_type']] ?? 9).compareTo(priority[b['entity_type']] ?? 9));
    for (final delta in deltas) {
      // Server deltas are events; append-only invoice/ledger rows never overwrite local printed bills.
      if (delta['entity_type'] == 'party') {
        final p = delta['payload'] as Map<String, dynamic>;
        await db.into(db.parties).insertOnConflictUpdate(PartiesCompanion.insert(
          id: p['id'] as String, name: p['name'] as String, phone: Value(p['phone'] as String?),
          type: p['type'] as String, creditLimit: Value((p['credit_limit'] as num?)?.toDouble() ?? 0),
          currentBalance: Value((p['current_balance'] as num?)?.toDouble() ?? 0),
          createdAt: DateTime.parse(p['created_at'] as String), updatedAt: DateTime.parse(p['updated_at'] as String),
          syncStatus: const Value('SYNCED')));
      } else if (delta['entity_type'] == 'product') {
        final p = delta['payload'] as Map<String, dynamic>;
        await db.into(db.products).insertOnConflictUpdate(ProductsCompanion.insert(
          id: p['id'] as String, name: p['name'] as String, hsnCode: Value(p['hsn_code'] as String?), unit: p['unit'] as String,
          wholesalePrice: (p['wholesale_price'] as num).toDouble(), retailPrice: (p['retail_price'] as num).toDouble(),
          purchasePrice: (p['purchase_price'] as num).toDouble(), stockQuantity: Value((p['stock_quantity'] as num?)?.toDouble() ?? 0),
          minStockAlert: Value((p['min_stock_alert'] as num?)?.toDouble() ?? 0), createdAt: DateTime.parse(p['created_at'] as String),
          updatedAt: DateTime.parse(p['updated_at'] as String), deletedAt: Value(p['deleted_at'] == null ? null : DateTime.parse(p['deleted_at'] as String)),
          syncStatus: const Value('SYNCED')));
      } else if (delta['entity_type'] == 'invoice') {
        final p = delta['payload'] as Map<String, dynamic>;
        final exists = await (db.select(db.invoices)..where((t) => t.id.equals(p['id'] as String))).getSingleOrNull();
        if (exists == null) {
          await db.into(db.invoices).insert(InvoicesCompanion.insert(id: p['id'] as String, invoiceNumber: p['invoice_number'] as String,
            partyId: p['party_id'] as String, totalAmount: (p['total_amount'] as num).toDouble(), paidAmount: (p['paid_amount'] as num).toDouble(),
            dueAmount: (p['due_amount'] as num).toDouble(), paymentMode: p['payment_mode'] as String,
            whatsappStatus: Value(p['whatsapp_status'] as String), createdAt: DateTime.parse(p['created_at'] as String),
            updatedAt: DateTime.parse(p['updated_at'] as String), dueDate: Value(p['due_date'] == null ? null : DateTime.parse(p['due_date'] as String)),
            syncStatus: const Value('SYNCED')));
          for (final raw in (p['items'] as List).cast<Map<String,dynamic>>()) {
            await db.into(db.invoiceItems).insert(InvoiceItemsCompanion.insert(id: raw['id'] as String,
              invoiceId: raw['invoice_id'] as String, productId: raw['product_id'] as String, quantity: (raw['quantity'] as num).toDouble(),
              unitPrice: (raw['unit_price'] as num).toDouble(), gstRate: (raw['gst_rate'] as num).toDouble(), totalPrice: (raw['total_price'] as num).toDouble(),
              createdAt: DateTime.parse(raw['created_at'] as String), updatedAt: DateTime.parse(raw['updated_at'] as String), syncStatus: const Value('SYNCED')));
          }
        }
      } else if (delta['entity_type'] == 'ledger_transaction') {
        final p = delta['payload'] as Map<String, dynamic>;
        await db.into(db.ledgerTransactions).insertOnConflictUpdate(LedgerTransactionsCompanion.insert(id: p['id'] as String,
          partyId: p['party_id'] as String, amount: (p['amount'] as num).toDouble(), paymentType: p['payment_type'] as String,
          referenceInvoiceId: Value(p['reference_invoice_id'] as String?), notes: Value(p['notes'] as String?),
          createdAt: DateTime.parse(p['created_at'] as String), updatedAt: DateTime.parse(p['updated_at'] as String), syncStatus: const Value('SYNCED')));
      } else if (delta['entity_type'] == 'stock_movement') {
        final p = delta['payload'] as Map<String, dynamic>;
        await db.into(db.stockMovements).insertOnConflictUpdate(StockMovementsCompanion.insert(id: p['id'] as String,
          productId: p['product_id'] as String, stockDelta: (p['stock_delta'] as num).toDouble(),
          referenceInvoiceId: Value(p['reference_invoice_id'] as String?), createdAt: DateTime.parse(p['created_at'] as String),
          updatedAt: DateTime.parse(p['created_at'] as String), syncStatus: const Value('SYNCED')));
      }
    }
  }
}
