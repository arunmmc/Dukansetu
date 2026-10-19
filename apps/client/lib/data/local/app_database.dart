import 'dart:io';
import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'tables.dart';
part 'app_database.g.dart';

@DriftDatabase(tables: [Parties, Products, Invoices, InvoiceItems, LedgerTransactions, StockMovements, OutboundSyncQueue, LocalMetadata])
class AppDatabase extends _$AppDatabase {
  AppDatabase(QueryExecutor executor) : super(executor);
  static Future<AppDatabase> open({required String sqlCipherKey}) async {
    if (sqlCipherKey.isEmpty) throw ArgumentError('A device-specific SQLCipher key is required');
    final dir = await getApplicationSupportDirectory();
    final file = File(p.join(dir.path, 'dukaan_setu.sqlite'));
    return AppDatabase(NativeDatabase.createInBackground(file, setup: (db) {
      final escapedKey = sqlCipherKey.replaceAll("'", "''");
      db.execute("PRAGMA key = '$escapedKey'");
      db.execute('PRAGMA foreign_keys = ON');
      db.execute('PRAGMA journal_mode = WAL');
    }));
  }
  @override int get schemaVersion => 1;
}
