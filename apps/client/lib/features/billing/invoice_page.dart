import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import '../../data/local/billing_repository.dart';
import '../../data/local/app_database.dart';
import '../../data/sync/sync_worker.dart';
import 'invoice_pdf.dart';
import 'package:printing/printing.dart';

class InvoicePage extends StatefulWidget {
  const InvoicePage({super.key, required this.database, required this.devicePrefix, required this.syncWorker});
  final AppDatabase database;
  final String devicePrefix;
  final SyncWorker? syncWorker;
  @override State<InvoicePage> createState() => _InvoicePageState();
}

class _InvoicePageState extends State<InvoicePage> {
  final _party = TextEditingController();
  final _phone = TextEditingController();
  final _paid = TextEditingController(text: '0');
  final List<_EditableLine> _lines = [_EditableLine()];
  bool _saving = false;
  bool _online = false;
  int _pending = 0;
  String _paymentMode = 'CASH';
  StreamSubscription<List<ConnectivityResult>>? _connectivity;
  @override void initState() {
    super.initState();
    _connectivity = Connectivity().onConnectivityChanged.listen((states) {
      final online = states.any((s) => s != ConnectivityResult.none);
      if (mounted) setState(() => _online = online);
      if (online) _sync();
      _refreshPending();
    });
    Connectivity().checkConnectivity().then((states) {
      if (mounted) setState(() => _online = states.any((s) => s != ConnectivityResult.none));
      if (_online) _sync();
    });
    _refreshPending();
  }
  Future<void> _refreshPending() async {
    final count = await (widget.database.select(widget.database.outboundSyncQueue)
      ..where((t) => t.entityType.equals('invoice'))).get();
    if (mounted) setState(() => _pending = count.length);
  }
  void _sync() { widget.syncWorker?.syncOnce().whenComplete(_refreshPending); }
  double get _total => _lines.fold(0, (s, l) => s + l.asDraft.total);
  @override void dispose() { _connectivity?.cancel(); _party.dispose(); _phone.dispose(); _paid.dispose(); for (final l in _lines) { l.dispose(); } super.dispose(); }

  @override Widget build(BuildContext context) => CallbackShortcuts(bindings: {
    const SingleActivator(LogicalKeyboardKey.enter, control: true): _save,
  }, child: Focus(autofocus: true, child: Scaffold(
    appBar: AppBar(title: const Text('Naya Bill'), actions: [Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16), child: Center(child: Text(_online
        ? (_pending == 0 ? 'ðŸŸ¢ Online â€¢ Synced' : widget.syncWorker == null ? 'ðŸŸ  Online â€¢ $_pending saved locally' : 'ðŸŸ  Online â€¢ $_pending bills syncing')
        : 'ðŸŸ  Offline â€¢ $_pending bills saved locally')))]),
    body: SafeArea(child: LayoutBuilder(builder: (context, box) => Center(child: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 900), child: ListView(padding: const EdgeInsets.all(16), children: [
        TextField(controller: _party, decoration: const InputDecoration(labelText: 'Customer name / Grahak')),
        TextField(controller: _phone, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'WhatsApp number')),
        const SizedBox(height: 16),
        ..._lines.asMap().entries.map((e) => _lineCard(e.key, e.value)),
        OutlinedButton.icon(onPressed: () => setState(() => _lines.add(_EditableLine())), icon: const Icon(Icons.add), label: const Text('Add item')),
        const SizedBox(height: 16),
        Text('Total Udhaar / Total: â‚¹${_total.toStringAsFixed(2)}', style: Theme.of(context).textTheme.titleLarge),
        DropdownButtonFormField<String>(value: _paymentMode, decoration: const InputDecoration(labelText: 'Payment mode / Bhugtan'),
          items: const [DropdownMenuItem(value: 'CASH', child: Text('Cash / Nagad')),
            DropdownMenuItem(value: 'UPI', child: Text('UPI')),
            DropdownMenuItem(value: 'UDHAAR', child: Text('Udhaar / Credit'))],
          onChanged: (value) { if (value != null) setState(() => _paymentMode = value); }),
        TextField(controller: _paid, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Paid now / Abhi mila')),
        const SizedBox(height: 20),
        FilledButton.icon(onPressed: _saving ? null : _save, icon: const Icon(Icons.receipt_long), label: const Padding(
          padding: EdgeInsets.symmetric(vertical: 14), child: Text('Save bill offline â€¢ Ctrl+Enter'))),
      ]))))),
  )));

  Widget _lineCard(int index, _EditableLine line) => Card(child: Padding(padding: const EdgeInsets.all(12), child: Column(children: [
    TextField(controller: line.name, decoration: InputDecoration(labelText: 'Item ${index + 1} / Samaan')),
    Row(children: [Expanded(child: TextField(controller: line.quantity, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Qty'))),
      const SizedBox(width: 12), Expanded(child: TextField(controller: line.price, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Rate â‚¹'))),
      if (_lines.length > 1) IconButton(onPressed: () => setState(() { _lines.removeAt(index).dispose(); }), icon: const Icon(Icons.delete_outline)),
    ]),
  ])));

  Future<void> _save() async {
    if (_party.text.trim().isEmpty) { _message('Enter customer name'); return; }
    setState(() => _saving = true);
    try {
      // Database and repository are injected by the application bootstrap in production.
      final repo = BillingRepository(widget.database, devicePrefix: widget.devicePrefix);
      final drafts = _lines.map((l) => l.asDraft).toList();
      final saved = await repo.createInvoice(partyName: _party.text, phone: _phone.text,
        lines: drafts, paid: double.tryParse(_paid.text) ?? 0, paymentMode: _paymentMode);
      await _refreshPending();
      if (_online) _sync();
      if (mounted) _message('Bill ${saved.number} saved. Syncing when online.');
      unawaited(_printSavedBill(saved, drafts, _party.text));
    } catch (e) { if (mounted) _message('Could not save bill: $e'); }
    finally { if (mounted) setState(() => _saving = false); }
  }
  Future<void> _printSavedBill(SavedInvoice invoice, List<DraftLine> lines, String partyName) async {
    try {
      final bytes = await InvoicePdf.build(shopName: 'My Dukaan', partyName: partyName, invoice: invoice, lines: lines);
      await Printing.layoutPdf(onLayout: (_) async => bytes);
    } catch (error) { if (mounted) _message('Bill saved, but PDF could not be opened: $error'); }
  }
  void _message(String text) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
}

class _EditableLine {
  final name = TextEditingController();
  final quantity = TextEditingController(text: '1');
  final price = TextEditingController();
  DraftLine get asDraft => DraftLine(name: name.text, quantity: double.tryParse(quantity.text) ?? 0,
    unitPrice: double.tryParse(price.text) ?? 0);
  void dispose() { name.dispose(); quantity.dispose(); price.dispose(); }
}

