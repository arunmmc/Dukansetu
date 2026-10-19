import 'dart:typed_data';
import 'package:intl/intl.dart';
import 'package:pdf/widgets.dart' as pw;
import '../../data/local/billing_repository.dart';

class InvoicePdf {
  static Future<Uint8List> build({required String shopName, required String partyName,
    required SavedInvoice invoice, required List<DraftLine> lines}) async {
    final doc = pw.Document();
    final currency = NumberFormat.currency(locale: 'en_IN', symbol: '₹');
    doc.addPage(pw.Page(build: (_) => pw.Column(crossAxisAlignment: pw.CrossAxisAlignment.start, children: [
      pw.Text(shopName, style: pw.TextStyle(fontSize: 22, fontWeight: pw.FontWeight.bold)),
      pw.SizedBox(height: 8), pw.Text('Invoice ${invoice.number}'), pw.Text('Bill To: $partyName'),
      pw.SizedBox(height: 20),
      pw.Table.fromTextArray(headers: ['Item', 'Qty', 'Rate', 'Amount'], data: [
        for (final line in lines) [line.name, '${line.quantity}', currency.format(line.unitPrice), currency.format(line.total)],
      ]),
      pw.SizedBox(height: 16), pw.Align(alignment: pw.Alignment.centerRight,
        child: pw.Column(crossAxisAlignment: pw.CrossAxisAlignment.end, children: [
          pw.Text('Total: ${currency.format(invoice.total)}'), pw.Text('Due: ${currency.format(invoice.due)}'),
        ])),
      pw.SizedBox(height: 24), pw.Text('Thank you for your business!'),
    ])));
    return doc.save();
  }
}
