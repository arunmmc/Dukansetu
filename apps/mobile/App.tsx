import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as SecureStore from 'expo-secure-store';
import { StatusBar } from 'expo-status-bar';
import { invoiceTotal, lineTotal, type DraftLine, type PaymentMode, type SavedInvoice, uuid } from '@dukaansetu/shared';
import { pushSync, queuedBills, saveInvoice } from './src/database';

const emptyLine=():DraftLine=>({name:'',quantity:1,unitPrice:0,gstRate:0});
const money=(n:number)=>`₹${n.toFixed(2)}`;

export default function App(){
  const [party,setParty]=useState(''),[phone,setPhone]=useState(''),[paid,setPaid]=useState('0'),[mode,setMode]=useState<PaymentMode>('CASH');
  const [lines,setLines]=useState<DraftLine[]>([emptyLine()]),[online,setOnline]=useState(false),[pending,setPending]=useState(0),[busy,setBusy]=useState(false);
  const [apiBase,setApiBase]=useState(''),[syncToken,setSyncToken]=useState(''),[showSettings,setShowSettings]=useState(false);
  const total=useMemo(()=>invoiceTotal(lines),[lines]);
  const update=(index:number,key:keyof DraftLine,value:string)=>setLines(rows=>rows.map((line,i)=>i===index?{...line,[key]:key==='name'?value:Number(value)||0}:line));
  const refresh=useCallback(async()=>setPending(await queuedBills()),[]);
  const sync=useCallback(async()=>{
    if(!online)return;
    const token=await SecureStore.getItemAsync('sync_token'),url=await SecureStore.getItemAsync('api_base_url');
    if(!token||!url)return;
    try{await pushSync(url,token);}catch{/* queued mutations remain durable for the next retry */}finally{await refresh();}
  },[online,refresh]);
  useEffect(()=>{const sub=NetInfo.addEventListener(state=>{const connected=!!state.isConnected;setOnline(connected);if(connected)void sync();});
    const timer=setInterval(()=>{void refresh();if(online)void sync();},30000);void refresh();return()=>{sub();clearInterval(timer);};},[refresh,sync,online]);
  useEffect(()=>{void Promise.all([SecureStore.getItemAsync('api_base_url'),SecureStore.getItemAsync('sync_token')]).then(([url,key])=>{setApiBase(url||'');setSyncToken(key||'');});},[]);

  const save=async()=>{
    setBusy(true);
    try{
      let prefix=await SecureStore.getItemAsync('invoice_prefix');if(!prefix){prefix=`D${uuid().slice(0,5).toUpperCase()}`;await SecureStore.setItemAsync('invoice_prefix',prefix);}
      const invoice=await saveInvoice({partyName:party,phone,paid:Number(paid)||0,paymentMode:mode,lines},prefix);
      await refresh();void sync();await makePdf(invoice,party,lines);
      setParty('');setPhone('');setPaid('0');setLines([emptyLine()]);
    }catch(e){Alert.alert('Could not save bill',e instanceof Error?e.message:'Check bill details');}
    finally{setBusy(false);}
  };

  return <KeyboardAvoidingView style={styles.root} behavior={Platform.OS==='ios'?'padding':undefined}>
    <StatusBar style="light"/><View style={styles.header}><View style={styles.brandMark}><Text style={styles.brandMarkText}>દ</Text></View><View style={{flex:1}}><Text style={styles.brand}>DukaanSetu</Text><Text style={styles.tagline}>Billing • Hisab • Dukaan</Text></View>
      <View style={[styles.onlinePill,{backgroundColor:online?'#dff3e8':'#fff0d4'}]}><Text style={{color:online?'#176b55':'#946014',fontWeight:'700'}}>{online?(pending?`Online • ${pending} bills`:'Online • Synced'):`Offline • ${pending} saved`}</Text></View></View>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <Text style={styles.eyebrow}>POINT OF SALE</Text><Text style={styles.title}>Naya Bill</Text>
      <Text style={styles.label}>Customer / Grahak</Text><TextInput value={party} onChangeText={setParty} placeholder="Customer name" style={styles.input} />
      <Text style={styles.label}>WhatsApp number</Text><TextInput value={phone} onChangeText={setPhone} placeholder="+91" keyboardType="phone-pad" style={styles.input}/>
      <View style={styles.itemsTitle}><Text style={styles.eyebrow}>ITEM DETAILS</Text><Text style={styles.eyebrow}>AMOUNT</Text></View>
      {lines.map((line,index)=><View key={index} style={styles.lineCard}>
        <TextInput value={line.name} onChangeText={v=>update(index,'name',v)} placeholder={`Item ${index+1} / Samaan`} style={[styles.input,styles.itemName]}/>
        <View style={styles.lineRow}><TextInput value={String(line.quantity)} onChangeText={v=>update(index,'quantity',v)} keyboardType="decimal-pad" placeholder="Qty" style={[styles.input,styles.smallInput]}/>
          <TextInput value={line.unitPrice?String(line.unitPrice):''} onChangeText={v=>update(index,'unitPrice',v)} keyboardType="decimal-pad" placeholder="Rate ₹" style={[styles.input,styles.smallInput]}/>
          <TextInput value={line.gstRate?String(line.gstRate):''} onChangeText={v=>update(index,'gstRate',v)} keyboardType="decimal-pad" placeholder="GST %" style={[styles.input,styles.smallInput]}/>
          {lines.length>1&&<Pressable onPress={()=>setLines(v=>v.filter((_,i)=>i!==index))}><Text style={styles.remove}>×</Text></Pressable>}</View>
        <Text style={styles.lineAmount}>{money(lineTotal(line))}</Text>
      </View>)}
      <Pressable style={styles.addButton} onPress={()=>setLines(v=>[...v,emptyLine()])}><Text style={styles.addText}>＋ Add item</Text></Pressable>
      <Text style={styles.label}>Payment mode / Bhugtan</Text><View style={styles.modeRow}>{(['CASH','UPI','UDHAAR'] as PaymentMode[]).map(v=><Pressable key={v} onPress={()=>setMode(v)} style={[styles.mode,{backgroundColor:mode===v?'#176b55':'white'}]}><Text style={{color:mode===v?'white':'#46564e',fontWeight:'700'}}>{v==='CASH'?'Cash':v==='UPI'?'UPI':'Udhaar'}</Text></Pressable>)}</View>
      <Text style={styles.label}>Paid now / Abhi mila</Text><TextInput value={paid} onChangeText={setPaid} keyboardType="decimal-pad" style={styles.input}/>
      <View style={styles.totals}><Text style={styles.totalLabel}>Total Udhaar / Total</Text><Text style={styles.totalValue}>{money(total)}</Text><Text style={styles.dueLabel}>Balance: {money(Math.max(0,total-(Number(paid)||0)))}</Text></View>
      <Pressable disabled={busy} style={[styles.saveButton,busy&&{opacity:.6}]} onPress={()=>void save()}><Text style={styles.saveText}>{busy?'Saving…':'Save bill & generate PDF'}</Text></Pressable>
      <Text style={styles.footnote}>Bill is saved on this device first. Sync runs when internet returns.</Text>
      <Pressable onPress={()=>setShowSettings(v=>!v)} style={styles.settingsToggle}><Text style={styles.addText}>{showSettings?'Hide':'Set up'} sync connection</Text></Pressable>
      {showSettings&&<View style={styles.settingsCard}><Text style={styles.label}>API server URL</Text><TextInput value={apiBase} onChangeText={setApiBase} autoCapitalize="none" keyboardType="url" placeholder="https://api.yourdukaan.in" style={styles.input}/>
        <Text style={styles.label}>Device sync token</Text><TextInput value={syncToken} onChangeText={setSyncToken} autoCapitalize="none" secureTextEntry placeholder="Provided by shop admin" style={styles.input}/>
        <Pressable style={[styles.saveButton,{paddingVertical:12}]} onPress={()=>{void SecureStore.setItemAsync('api_base_url',apiBase.trim()).then(()=>SecureStore.setItemAsync('sync_token',syncToken.trim())).then(()=>{Alert.alert('Saved','Sync connection details saved securely.');void sync();});}}><Text style={styles.saveText}>Save connection</Text></Pressable>
      </View>}
    </ScrollView>
  </KeyboardAvoidingView>;
}

async function makePdf(invoice:SavedInvoice,party:string,lines:DraftLine[]){
  const rows=lines.map(l=>`<tr><td>${escapeHtml(l.name)}</td><td>${l.quantity}</td><td>${money(l.unitPrice)}</td><td>${money(lineTotal(l))}</td></tr>`).join('');
  const html=`<html><body style="font-family:Arial;padding:30px;color:#24342c"><h1>DukaanSetu</h1><h2>Invoice ${invoice.number}</h2><p>Customer: ${escapeHtml(party)}</p><table width="100%" cellspacing="0" cellpadding="8" border="1"><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr>${rows}</table><p>Total: ${money(invoice.total)}</p><p>Paid: ${money(invoice.paid)}</p><h3>Balance: ${money(invoice.due)}</h3></body></html>`;
  const file=await Print.printToFileAsync({html});if(await Sharing.isAvailableAsync())await Sharing.shareAsync(file.uri,{mimeType:'application/pdf',dialogTitle:invoice.number});
}
const escapeHtml=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

const styles=StyleSheet.create({root:{flex:1,backgroundColor:'#f4f6f3'},header:{height:76,backgroundColor:'#176b55',paddingHorizontal:18,flexDirection:'row',alignItems:'center',gap:10},brandMark:{width:38,height:38,borderRadius:11,backgroundColor:'#ffffff25',alignItems:'center',justifyContent:'center'},brandMarkText:{color:'white',fontSize:22,fontWeight:'800'},brand:{color:'white',fontSize:16,fontWeight:'800'},tagline:{color:'#cce2d8',fontSize:10},onlinePill:{paddingHorizontal:10,paddingVertical:8,borderRadius:20},content:{padding:18,paddingBottom:45},eyebrow:{fontSize:10,fontWeight:'800',letterSpacing:1.2,color:'#708078'},title:{fontSize:28,fontWeight:'800',color:'#1b2b24',marginTop:5,marginBottom:16},label:{fontSize:12,fontWeight:'700',color:'#58665f',marginTop:12,marginBottom:6},input:{minHeight:46,borderRadius:8,borderWidth:1,borderColor:'#dce4de',backgroundColor:'white',paddingHorizontal:12,fontSize:15,color:'#1b2b24'},itemsTitle:{marginTop:25,marginBottom:5,flexDirection:'row',justifyContent:'space-between'},lineCard:{backgroundColor:'white',borderRadius:10,borderWidth:1,borderColor:'#e6ebe6',padding:10,marginTop:9},itemName:{fontWeight:'600'},lineRow:{flexDirection:'row',gap:8,marginTop:8},smallInput:{flex:1,minWidth:0,minHeight:42,paddingHorizontal:9},lineAmount:{textAlign:'right',fontWeight:'700',color:'#26382e',marginTop:9},remove:{fontSize:25,color:'#a56352',paddingHorizontal:2},addButton:{paddingVertical:15},addText:{color:'#176b55',fontWeight:'800'},modeRow:{flexDirection:'row',gap:8},mode:{flex:1,alignItems:'center',padding:12,borderWidth:1,borderColor:'#dce4de',borderRadius:8},totals:{marginTop:20,paddingVertical:17,borderTopWidth:1,borderTopColor:'#e1e7e1',borderBottomWidth:1,borderBottomColor:'#e1e7e1'},totalLabel:{fontSize:13,color:'#68766e'},totalValue:{fontSize:26,fontWeight:'800',color:'#182921',marginTop:3},dueLabel:{fontSize:13,color:'#b96634',fontWeight:'700',marginTop:5},saveButton:{backgroundColor:'#176b55',borderRadius:9,alignItems:'center',paddingVertical:16,marginTop:17},saveText:{fontWeight:'800',color:'white',fontSize:15},footnote:{fontSize:11,color:'#77847c',textAlign:'center',marginTop:12},settingsToggle:{paddingVertical:16,alignSelf:'center'},settingsCard:{padding:14,backgroundColor:'white',borderRadius:10,borderWidth:1,borderColor:'#e1e7e1'}});
