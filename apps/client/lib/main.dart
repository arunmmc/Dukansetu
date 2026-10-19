import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:uuid/uuid.dart';
import 'data/local/app_database.dart';
import 'data/sync/sync_worker.dart';
import 'features/billing/invoice_page.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  const secure = FlutterSecureStorage();
  final key = await secure.read(key: 'sqlcipher_key') ?? const Uuid().v4();
  await secure.write(key: 'sqlcipher_key', value: key);
  final prefix = await secure.read(key: 'invoice_prefix') ?? 'D${const Uuid().v4().substring(0, 5).toUpperCase()}';
  await secure.write(key: 'invoice_prefix', value: prefix);
  final database = await AppDatabase.open(sqlCipherKey: key);
  final token = await secure.read(key: 'sync_token');
  const apiUrl = String.fromEnvironment('API_BASE_URL');
  final syncWorker = token == null || apiUrl.isEmpty ? null : SyncWorker(db: database, baseUrl: apiUrl, syncToken: token);
  runApp(DukaanSetuApp(database: database, devicePrefix: prefix, syncWorker: syncWorker));
}

class DukaanSetuApp extends StatelessWidget {
  const DukaanSetuApp({super.key, required this.database, required this.devicePrefix, required this.syncWorker});
  final AppDatabase database;
  final String devicePrefix;
  final SyncWorker? syncWorker;

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'DukaanSetu',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(colorSchemeSeed: const Color(0xff176b55), useMaterial3: true),
        home: InvoicePage(database: database, devicePrefix: devicePrefix, syncWorker: syncWorker),
      );
}
