import 'package:drift/drift.dart';

class Parties extends Table {
  TextColumn get id => text()();
  TextColumn get name => text()();
  TextColumn get phone => text().nullable()();
  TextColumn get gstin => text().nullable()();
  TextColumn get type => text()();
  RealColumn get creditLimit => real().withDefault(const Constant(0))();
  RealColumn get currentBalance => real().withDefault(const Constant(0))();
  DateTimeColumn get createdAt => dateTime()();
  DateTimeColumn get updatedAt => dateTime()();
  DateTimeColumn get deletedAt => dateTime().nullable()();
  TextColumn get syncStatus => text().withDefault(const Constant('PENDING'))();
  @override Set<Column> get primaryKey => {id};
}

class Products extends Table {
  TextColumn get id => text()();
  TextColumn get name => text()();
  TextColumn get hsnCode => text().nullable()();
  TextColumn get unit => text()();
  RealColumn get wholesalePrice => real()();
  RealColumn get retailPrice => real()();
  RealColumn get purchasePrice => real()();
  RealColumn get stockQuantity => real().withDefault(const Constant(0))();
  RealColumn get minStockAlert => real().withDefault(const Constant(0))();
  DateTimeColumn get createdAt => dateTime()();
  DateTimeColumn get updatedAt => dateTime()();
  DateTimeColumn get deletedAt => dateTime().nullable()();
  TextColumn get syncStatus => text().withDefault(const Constant('PENDING'))();
  @override Set<Column> get primaryKey => {id};
}

class Invoices extends Table {
  TextColumn get id => text()();
  TextColumn get invoiceNumber => text()();
  TextColumn get partyId => text().references(Parties, #id)();
  RealColumn get totalAmount => real()();
  RealColumn get paidAmount => real()();
  RealColumn get dueAmount => real()();
  TextColumn get paymentMode => text()();
  TextColumn get whatsappStatus => text().withDefault(const Constant('QUEUED'))();
  DateTimeColumn get dueDate => dateTime().nullable()();
  DateTimeColumn get createdAt => dateTime()();
  DateTimeColumn get updatedAt => dateTime()();
  DateTimeColumn get deletedAt => dateTime().nullable()();
  TextColumn get syncStatus => text().withDefault(const Constant('PENDING'))();
  @override Set<Column> get primaryKey => {id};
}

class InvoiceItems extends Table {
  TextColumn get id => text()();
  TextColumn get invoiceId => text().references(Invoices, #id)();
  TextColumn get productId => text()();
  RealColumn get quantity => real()();
  RealColumn get unitPrice => real()();
  RealColumn get gstRate => real()();
  RealColumn get totalPrice => real()();
  DateTimeColumn get createdAt => dateTime()();
  DateTimeColumn get updatedAt => dateTime()();
  DateTimeColumn get deletedAt => dateTime().nullable()();
  TextColumn get syncStatus => text().withDefault(const Constant('PENDING'))();
  @override Set<Column> get primaryKey => {id};
}

class LedgerTransactions extends Table {
  TextColumn get id => text()();
  TextColumn get partyId => text().references(Parties, #id)();
  RealColumn get amount => real()();
  TextColumn get paymentType => text()();
  TextColumn get referenceInvoiceId => text().nullable()();
  TextColumn get notes => text().nullable()();
  DateTimeColumn get createdAt => dateTime()();
  DateTimeColumn get updatedAt => dateTime()();
  DateTimeColumn get deletedAt => dateTime().nullable()();
  TextColumn get syncStatus => text().withDefault(const Constant('PENDING'))();
  @override Set<Column> get primaryKey => {id};
}

class StockMovements extends Table {
  TextColumn get id => text()();
  TextColumn get productId => text()();
  RealColumn get stockDelta => real()();
  TextColumn get referenceInvoiceId => text().nullable()();
  DateTimeColumn get createdAt => dateTime()();
  DateTimeColumn get updatedAt => dateTime()();
  DateTimeColumn get deletedAt => dateTime().nullable()();
  TextColumn get syncStatus => text().withDefault(const Constant('PENDING'))();
  @override Set<Column> get primaryKey => {id};
}

class OutboundSyncQueue extends Table {
  TextColumn get id => text()();
  TextColumn get entityType => text()();
  TextColumn get entityId => text()();
  TextColumn get operation => text()();
  TextColumn get payloadJson => text()();
  IntColumn get attempts => integer().withDefault(const Constant(0))();
  DateTimeColumn get createdAt => dateTime()();
  TextColumn get lastError => text().nullable()();
  @override Set<Column> get primaryKey => {id};
}

class LocalMetadata extends Table {
  TextColumn get key => text()();
  TextColumn get value => text()();
  @override Set<Column> get primaryKey => {key};
}
