Attribute VB_Name = "modTracker"
Option Explicit
'============ modTracker - Plan Tracker (MOs of same BOM merged) ============
' Same BOM = one order for production, even if it has several MOs.
' Required = sum of all MOs. Logging deducts from the merged total.

Public Sub ShowPlan()
    NormalizeBoms
    ReallocateExcess
    Dim tr As Worksheet, orders As Worksheet, logS As Worksheet
    Set tr = Sheets("Plan Tracker"): Set orders = Sheets("Plan Orders")
    Set logS = Sheets("Daily Handover")
    Dim planNo As Double: planNo = Nv(tr.Range("B2").Value)
    If planNo = 0 Then MsgBox "Pick a plan number in B2.", vbExclamation: Exit Sub
    Dim IT As Variant: IT = ItemsArr()
    ' ---- aggregate Plan Orders per BOM (all MOs merged) ----
    Dim recIdx As Object: Set recIdx = NewDict()
    Dim maxR As Long: maxR = 500
    Dim rBom() As String, rKva() As Variant, rReq() As Double
    Dim rTgt() As Object, rMos() As Object
    ReDim rBom(1 To maxR): ReDim rKva(1 To maxR): ReDim rReq(1 To maxR)
    ReDim rTgt(1 To maxR): ReDim rMos(1 To maxR)
    Dim nRec As Long: nRec = 0
    Dim moSeen As Object: Set moSeen = NewDict()
    Dim oLast As Long: oLast = orders.Cells(orders.Rows.Count, 1).End(xlUp).Row
    Dim i As Long, ri As Long
    If oLast >= 2 Then
        Dim oV As Variant: oV = orders.Range("A2:J" & oLast).Value
        For i = 1 To UBound(oV, 1)
            If Nv(oV(i, 1)) = planNo Then
                Dim bom As String: bom = S(oV(i, 2))
                Dim mo As String: mo = S(oV(i, 4))
                If bom <> "" Then
                    If Not recIdx.Exists(bom) Then
                        nRec = nRec + 1
                        recIdx.Add bom, nRec
                        rBom(nRec) = bom: rKva(nRec) = oV(i, 5): rReq(nRec) = 0
                        Set rTgt(nRec) = NewDict()
                        Set rMos(nRec) = NewDict()
                    End If
                    ri = recIdx(bom)
                    If Not moSeen.Exists(bom & "|" & mo) Then
                        moSeen.Add bom & "|" & mo, True
                        rReq(ri) = rReq(ri) + Nv(oV(i, 7))
                        rMos(ri)(mo) = True
                    End If
                    DAdd rTgt(ri), S(oV(i, 6)), Nv(oV(i, 9))
                End If
            End If
        Next i
    End If
    ' ---- logged production (per week/plan) ----
    Dim logged As Object: Set logged = NewDict()
    logged.Add "Cut", NewDict(): logged.Add "Welding", NewDict()
    Dim lLast As Long: lLast = logS.Cells(logS.Rows.Count, 1).End(xlUp).Row
    If lLast >= 2 Then
        Dim lV As Variant: lV = logS.Range("A2:F" & lLast).Value
        For i = 1 To UBound(lV, 1)
            If Nv(lV(i, 6)) = planNo Then
                Dim dept As String: dept = S(lV(i, 2))
                If logged.Exists(dept) Then
                    DAdd logged(dept), S(lV(i, 3)) & "|" & S(lV(i, 4)), Nv(lV(i, 5))
                End If
            End If
        Next i
    End If
    ' ---- one row per BOM ----
    Dim out() As Variant: ReDim out(1 To nRec + 1, 1 To 15)
    Dim t As Long
    For ri = 1 To nRec
        out(ri, 1) = rBom(ri)
        Dim moTxt As String: moTxt = ""
        Dim mk As Variant
        For Each mk In rMos(ri).Keys
            If moTxt = "" Then moTxt = CStr(mk)
        Next mk
        If rMos(ri).Count > 1 Then moTxt = moTxt & " +" & (rMos(ri).Count - 1) & " MO"
        out(ri, 2) = moTxt
        out(ri, 3) = rKva(ri): out(ri, 4) = rReq(ri)
        Dim completed As Double, haveC As Boolean: haveC = False
        For t = 0 To 3
            Dim itT As String: itT = CStr(IT(t))
            Dim tg As Double
            If rTgt(ri).Exists(itT) Then tg = rTgt(ri)(itT) Else tg = rReq(ri)
            If tg > rReq(ri) Then tg = rReq(ri)
            Dim pre As Double: pre = rReq(ri) - tg
            If pre < 0 Then pre = 0
            Dim effCut As Double, effWeld As Double
            effCut = pre + DGet(logged("Cut"), rBom(ri) & "|" & itT)
            If effCut > rReq(ri) Then effCut = rReq(ri)
            effWeld = pre + DGet(logged("Welding"), rBom(ri) & "|" & itT)
            If effWeld > rReq(ri) Then effWeld = rReq(ri)
            out(ri, 5 + 2 * t) = effCut
            out(ri, 6 + 2 * t) = effWeld
            If Not haveC Then
                completed = effWeld: haveC = True
            ElseIf effWeld < completed Then
                completed = effWeld
            End If
        Next t
        If Not haveC Then completed = 0
        out(ri, 13) = completed
        out(ri, 14) = rReq(ri) - completed
        If out(ri, 14) < 0 Then out(ri, 14) = 0
        If rReq(ri) > 0 Then out(ri, 15) = completed / rReq(ri) Else out(ri, 15) = ""
    Next ri
    tr.Range("A5:O2000").ClearContents
    If nRec > 0 Then tr.Range("A5").Resize(nRec, 15).Value = out
    FormatTracker
End Sub

Public Sub FormatTracker()
    Dim tr As Worksheet: Set tr = Sheets("Plan Tracker")
    Application.ScreenUpdating = False
    With tr.Range("A5:O2000")
        .FormatConditions.Delete
        .Interior.ColorIndex = xlNone
        .Borders.LineStyle = xlNone
        .Font.Bold = False
        .Font.ColorIndex = xlAutomatic
        .Font.Name = "Calibri": .Font.Size = 11
        .HorizontalAlignment = xlCenter
        .VerticalAlignment = xlCenter
    End With
    Dim lastR As Long: lastR = tr.Cells(tr.Rows.Count, 1).End(xlUp).Row
    If lastR < 5 Then Application.ScreenUpdating = True: Exit Sub
    Dim body As Range: Set body = tr.Range("A5:O" & lastR)
    Dim c As Variant
    For Each c In Array("E", "G", "I", "K")
        tr.Range(c & "5:" & c & lastR).Interior.Color = RGB(226, 239, 218)
    Next c
    For Each c In Array("F", "H", "J", "L")
        tr.Range(c & "5:" & c & lastR).Interior.Color = RGB(221, 235, 247)
    Next c
    Dim r As Long
    For r = 6 To lastR Step 2
        tr.Range("A" & r & ":D" & r).Interior.Color = RGB(242, 247, 251)
        tr.Range("M" & r & ":O" & r).Interior.Color = RGB(242, 247, 251)
    Next r
    tr.Range("M5:N" & lastR).Font.Bold = True
    tr.Range("O5:O" & lastR).NumberFormat = "0.0%"
    With body.Borders
        .LineStyle = xlContinuous: .Weight = xlThin: .Color = RGB(191, 191, 191)
    End With
    For Each c In Array("D", "F", "H", "J", "L")
        With tr.Range(c & "5:" & c & lastR).Borders(xlEdgeRight)
            .LineStyle = xlContinuous: .Weight = xlMedium: .Color = RGB(132, 150, 176)
        End With
    Next c
    With tr.Range("A" & lastR & ":O" & lastR).Borders(xlEdgeBottom)
        .LineStyle = xlContinuous: .Weight = xlMedium: .Color = RGB(132, 150, 176)
    End With
    With tr.Range("N5:N" & lastR)
        With .FormatConditions.Add(Type:=xlCellValue, Operator:=xlGreater, Formula1:="=0")
            .Font.Color = RGB(192, 0, 0): .Font.Bold = True
        End With
        With .FormatConditions.Add(Type:=xlCellValue, Operator:=xlEqual, Formula1:="=0")
            .Font.Color = RGB(56, 118, 29): .Font.Bold = True
        End With
    End With
    Dim cs As ColorScale
    Set cs = tr.Range("O5:O" & lastR).FormatConditions.AddColorScale(ColorScaleType:=3)
    With cs.ColorScaleCriteria(1)
        .Type = xlConditionValueNumber: .Value = 0
        .FormatColor.Color = RGB(244, 183, 176)
    End With
    With cs.ColorScaleCriteria(2)
        .Type = xlConditionValueNumber: .Value = 0.5
        .FormatColor.Color = RGB(252, 228, 166)
    End With
    With cs.ColorScaleCriteria(3)
        .Type = xlConditionValueNumber: .Value = 1
        .FormatColor.Color = RGB(169, 211, 160)
    End With
    Application.ScreenUpdating = True
End Sub
