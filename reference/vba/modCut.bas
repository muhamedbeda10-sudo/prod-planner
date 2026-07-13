Attribute VB_Name = "modCut"
Option Explicit
'============ modCut - "Cut Worklist" sheet ============
' Cut works leadCut days (Lists!J2) before oven date.
' Daily capacity = Lists!J4 PER ITEM. Scheduled first,
' then fill-up from unscheduled backlog to close capacity.
' BOMs with same base + same M number are merged (BomGroup).
' Col E "Total Required" = full remaining target from Plan Orders.

Public Sub ShowCutDay()
    NormalizeBoms
    ReallocateExcess
    Dim ws As Worksheet, plans As Worksheet, orders As Worksheet
    Dim logS As Worksheet, lists As Worksheet
    Set ws = Sheets("Cut Worklist"): Set plans = Sheets("Plans")
    Set orders = Sheets("Plan Orders"): Set logS = Sheets("Daily Handover")
    Set lists = Sheets("Lists")

    Dim D As Variant: D = ws.Range("B2").Value
    If Not IsDateVal(D) Then MsgBox "Pick a day in B2.", vbExclamation: Exit Sub
    Dim Dt As Long: Dt = DOnly(D)

    Dim leadCut As Double, capItem As Double
    leadCut = Nv(lists.Range("J2").Value): If leadCut = 0 Then leadCut = 2
    capItem = Nv(lists.Range("J4").Value): If capItem = 0 Then capItem = 27

    Dim planNo As Double: planNo = FindPlanForDate(Dt, leadCut)
    If planNo = -1 Then MsgBox "No imported plan covers this date.", vbExclamation: Exit Sub

    Dim IT As Variant: IT = ItemsArr()
    Dim i As Long

    ' ---- Plans: totals + cumulative cut due ----
    Dim aKva As Object, aTot As Object, aDC As Object, kvaOf As Object
    Set aKva = NewDict(): Set aTot = NewDict(): Set aDC = NewDict(): Set kvaOf = NewDict()
    Dim pLast As Long: pLast = plans.Cells(plans.Rows.Count, 1).End(xlUp).Row
    If pLast >= 2 Then
        Dim pV As Variant: pV = plans.Range("A2:H" & pLast).Value
        For i = 1 To UBound(pV, 1)
            If Nv(pV(i, 1)) = planNo And IsDateVal(pV(i, 7)) Then
                Dim bomP As String: bomP = BomGroup(S(pV(i, 2)))
                Dim keyP As String: keyP = bomP & "|" & S(pV(i, 6))
                If Not aKva.Exists(keyP) Then aKva.Add keyP, pV(i, 5)
                DAdd aTot, keyP, Nv(pV(i, 8))
                If DOnly(pV(i, 7)) <= Dt + leadCut Then DAdd aDC, keyP, Nv(pV(i, 8))
                kvaOf(bomP) = pV(i, 5)
            End If
        Next i
    End If

    ' ---- Plan Orders: targets + BOM order ----
    Dim tgt As Object, kva2 As Object, bomSeen As Object
    Set tgt = NewDict(): Set kva2 = NewDict(): Set bomSeen = NewDict()
    Dim bomOrder As Collection: Set bomOrder = New Collection
    Dim oLast As Long: oLast = orders.Cells(orders.Rows.Count, 1).End(xlUp).Row
    If oLast >= 2 Then
        Dim oV As Variant: oV = orders.Range("A2:J" & oLast).Value
        For i = 1 To UBound(oV, 1)
            If Nv(oV(i, 1)) = planNo Then
                Dim bomO As String: bomO = BomGroup(S(oV(i, 2)))
                DAdd tgt, bomO & "|" & S(oV(i, 6)), Nv(oV(i, 9))
                If Not bomSeen.Exists(bomO) Then bomSeen.Add bomO, True: bomOrder.Add bomO
                If Not kva2.Exists(bomO) Then kva2.Add bomO, oV(i, 5)
            End If
        Next i
    End If

    ' ---- Handover: cut before / today / cumulative ----
    Dim cutPrev As Object, cutT As Object, cutCum As Object
    Set cutPrev = NewDict(): Set cutT = NewDict(): Set cutCum = NewDict()
    Dim lLast As Long: lLast = logS.Cells(logS.Rows.Count, 1).End(xlUp).Row
    If lLast >= 2 Then
        Dim lV As Variant: lV = logS.Range("A2:F" & lLast).Value
        For i = 1 To UBound(lV, 1)
            If Nv(lV(i, 6)) = planNo And IsDateVal(lV(i, 1)) Then
                If S(lV(i, 2)) = "Cut" Then
                    Dim dtl As Long: dtl = DOnly(lV(i, 1))
                    Dim keyL As String: keyL = BomGroup(S(lV(i, 3))) & "|" & S(lV(i, 4))
                    Dim qL As Double: qL = Nv(lV(i, 5))
                    If dtl < Dt Then DAdd cutPrev, keyL, qL
                    If dtl = Dt Then DAdd cutT, keyL, qL
                    If dtl <= Dt Then DAdd cutCum, keyL, qL
                End If
            End If
        Next i
    End If

    ' ---- scheduled rows ----
    Dim out() As Variant: ReDim out(1 To aKva.Count + 200, 1 To 10)
    Dim nOut As Long: nOut = 0
    Dim kk As Variant, parts() As String
    For Each kk In aKva.Keys
        Dim gDC As Double: gDC = DGet(aDC, CStr(kk))
        If gDC > 0 Then
            Dim dueC As Double, stillC As Double
            dueC = gDC - DGet(cutPrev, CStr(kk)): If dueC < 0 Then dueC = 0
            stillC = dueC - DGet(cutT, CStr(kk)): If stillC < 0 Then stillC = 0
            parts = Split(CStr(kk), "|")
            nOut = nOut + 1
            out(nOut, 1) = parts(0): out(nOut, 2) = aKva(kk): out(nOut, 3) = parts(1)
            out(nOut, 4) = "Scheduled": out(nOut, 5) = DGet(tgt, CStr(kk))
            out(nOut, 6) = dueC: out(nOut, 7) = DGet(cutT, CStr(kk)): out(nOut, 8) = stillC
            out(nOut, 9) = 0
            If stillC = 0 Then
                out(nOut, 10) = "Done"
            ElseIf DGet(cutT, CStr(kk)) > 0 Then
                out(nOut, 10) = "In progress"
            Else
                out(nOut, 10) = "Pending"
            End If
        End If
    Next kk

    ' sort by BOM then Item
    Dim x As Long, y As Long, c As Long, tmp As Variant
    For x = 1 To nOut - 1
        For y = x + 1 To nOut
            If out(y, 1) < out(x, 1) Or (out(y, 1) = out(x, 1) And out(y, 3) < out(x, 3)) Then
                For c = 1 To 10
                    tmp = out(x, c): out(x, c) = out(y, c): out(y, c) = tmp
                Next c
            End If
        Next y
    Next x

    ' ---- capacity allocation: Today Target (col I) ----
    Dim capUsed As Object: Set capUsed = NewDict()
    For Each kk In cutT.Keys
        parts = Split(CStr(kk), "|")
        DAdd capUsed, parts(1), cutT(kk)
    Next kk
    For i = 1 To nOut
        Dim room As Double: room = capItem - DGet(capUsed, CStr(out(i, 3)))
        If room < 0 Then room = 0
        Dim alloc As Double: alloc = Nv(out(i, 8))
        If alloc > room Then alloc = room
        out(i, 9) = alloc
        DAdd capUsed, CStr(out(i, 3)), alloc
    Next i

    ' ---- fill-up from unscheduled backlog (close the capacity) ----
    Dim ti As Long, bi As Long
    For ti = 0 To 3
        Dim itF As String: itF = CStr(IT(ti))
        Dim need As Double: need = capItem - DGet(capUsed, itF)
        For bi = 1 To bomOrder.Count
            If need <= 0 Then Exit For
            Dim bomF As String: bomF = bomOrder(bi)
            Dim keyF As String: keyF = bomF & "|" & itF
            Dim base As Double: base = DGet(aTot, keyF)
            If DGet(cutCum, keyF) > base Then base = DGet(cutCum, keyF)
            Dim pool As Double: pool = DGet(tgt, keyF) - base
            If pool > 0 Then
                Dim takeF As Double: takeF = pool
                If need < takeF Then takeF = need
                nOut = nOut + 1
                out(nOut, 1) = bomF
                If kva2.Exists(bomF) Then
                    out(nOut, 2) = kva2(bomF)
                ElseIf kvaOf.Exists(bomF) Then
                    out(nOut, 2) = kvaOf(bomF)
                Else
                    out(nOut, 2) = ""
                End If
                out(nOut, 3) = itF: out(nOut, 4) = "Fill-up (unscheduled)"
                out(nOut, 5) = DGet(tgt, keyF)
                out(nOut, 6) = takeF: out(nOut, 7) = 0: out(nOut, 8) = takeF
                out(nOut, 9) = takeF
                out(nOut, 10) = "Pending"
                need = need - takeF
                DAdd capUsed, itF, takeF
            End If
        Next bi
    Next ti

    ws.Range("A5:J2000").ClearContents
    If nOut > 0 Then ws.Range("A5").Resize(nOut, 10).Value = out
    FormatCutList
End Sub

Public Sub FormatCutList()
    Dim ws As Worksheet: Set ws = Sheets("Cut Worklist")
    Application.ScreenUpdating = False
    With ws.Range("A5:J2000")
        .FormatConditions.Delete
        .Interior.ColorIndex = xlNone
        .Borders.LineStyle = xlNone
        .Font.Bold = False
        .Font.ColorIndex = xlAutomatic
        .Font.Name = "Calibri": .Font.Size = 11
        .HorizontalAlignment = xlCenter
        .VerticalAlignment = xlCenter
    End With
    Dim lastR As Long: lastR = ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
    If lastR < 5 Then Application.ScreenUpdating = True: Exit Sub
    ws.Range("F5:I" & lastR).Interior.Color = RGB(226, 239, 218)
    Dim r As Long
    For r = 6 To lastR Step 2
        ws.Range("A" & r & ":E" & r).Interior.Color = RGB(242, 247, 251)
    Next r
    For r = 5 To lastR
        If ws.Cells(r, 4).Value = "Fill-up (unscheduled)" Then
            ws.Cells(r, 4).Interior.Color = RGB(255, 242, 204)
        End If
    Next r
    ws.Range("I5:I" & lastR).Font.Bold = True
    With ws.Range("A5:J" & lastR).Borders
        .LineStyle = xlContinuous: .Weight = xlThin: .Color = RGB(191, 191, 191)
    End With
    With ws.Range("A" & lastR & ":J" & lastR).Borders(xlEdgeBottom)
        .LineStyle = xlContinuous: .Weight = xlMedium: .Color = RGB(132, 150, 176)
    End With
    Dim st As Range: Set st = ws.Range("J5:J" & lastR)
    st.Font.Bold = True
    With st.FormatConditions.Add(Type:=xlTextString, String:="Done", TextOperator:=xlContains)
        .Interior.Color = RGB(198, 239, 206): .Font.Color = RGB(0, 97, 0)
    End With
    With st.FormatConditions.Add(Type:=xlTextString, String:="progress", TextOperator:=xlContains)
        .Interior.Color = RGB(255, 242, 204): .Font.Color = RGB(127, 96, 0)
    End With
    With st.FormatConditions.Add(Type:=xlTextString, String:="Pending", TextOperator:=xlContains)
        .Interior.Color = RGB(255, 199, 206): .Font.Color = RGB(156, 0, 6)
    End With
    Dim db As Databar
    Set db = ws.Range("H5:H" & lastR).FormatConditions.AddDatabar
    db.BarColor.Color = RGB(46, 117, 182)
    Application.ScreenUpdating = True
End Sub
