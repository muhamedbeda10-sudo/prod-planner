Attribute VB_Name = "modShared"
Option Explicit
'============ modShared - helpers used by ALL modules ============
' BOM family merge cache (same base + same M number = one order)
Private repMap As Object
Private repBuiltAt As Double

Public Function ItemsArr() As Variant
    ItemsArr = Array("CF", "TC", "TN", "CB")
End Function

Public Function S(v As Variant) As String
    On Error Resume Next
    S = Trim$(CStr(v & ""))
End Function

Public Function Nv(v As Variant) As Double
    If IsNumeric(v) Then Nv = CDbl(v) Else Nv = 0
End Function

Public Function IsDateVal(v As Variant) As Boolean
    IsDateVal = (VarType(v) = vbDate)
End Function

Public Function DOnly(v As Variant) As Long
    DOnly = Int(CDbl(v))
End Function

Public Function DGet(D As Object, k As String) As Double
    If D.Exists(k) Then DGet = D(k) Else DGet = 0
End Function

Public Sub DAdd(D As Object, k As String, q As Double)
    If D.Exists(k) Then D(k) = D(k) + q Else D.Add k, q
End Sub

Public Function NewDict() As Object
    Set NewDict = CreateObject("Scripting.Dictionary")
End Function

Public Function MinOf4(a As Double, b As Double, c As Double, D As Double) As Double
    Dim m As Double: m = a
    If b < m Then m = b
    If c < m Then m = c
    If D < m Then m = D
    MinOf4 = m
End Function

Public Function BomPrefix(sIn As String) As String
    Dim re As Object: Set re = CreateObject("VBScript.RegExp")
    re.Pattern = "^(.*?)E\d"
    Dim u As String: u = UCase$(sIn)
    If re.Test(u) Then
        BomPrefix = re.Execute(u)(0).SubMatches(0)
    Else
        BomPrefix = u
    End If
End Function

' plan whose window (start - lead days) covers the date
Public Function FindPlanForDate(Dt As Long, lead As Double) As Double
    Dim lists As Worksheet: Set lists = Sheets("Lists")
    Dim reg As Variant: reg = lists.Range("E2:F60").Value
    Dim i As Long, bestStart As Long: bestStart = -1
    FindPlanForDate = -1
    For i = 1 To UBound(reg, 1)
        If Nv(reg(i, 1)) <> 0 And IsDateVal(reg(i, 2)) Then
            Dim sst As Long: sst = DOnly(reg(i, 2))
            If sst - lead <= Dt And (bestStart = -1 Or sst > bestStart) Then
                bestStart = sst: FindPlanForDate = Nv(reg(i, 1))
            End If
        End If
    Next i
End Function

' Same base number + same M number = ONE production order.
' 12011E13M12 & 12011E14M12 are merged, and BOTH show as the first
' real code found in Plan Orders (e.g. 12011E13M12) - one row, real code.
Public Function BomGroup(sIn As String) As String
    Dim u As String: u = UCase$(Trim$(sIn))
    If u = "" Then BomGroup = u: Exit Function
    Dim k As String: k = GroupKey(u)
    EnsureRepMap
    If repMap.Exists(k) Then
        BomGroup = repMap(k)
    Else
        BomGroup = u
    End If
End Function

' base number + M number, e.g. 12011E13M12 -> "12011|M12"
Private Function GroupKey(u As String) As String
    Dim re As Object: Set re = CreateObject("VBScript.RegExp")
    re.Pattern = "^(.+?)E\d+(M\d+)$"
    If re.Test(u) Then
        Dim m As Object: Set m = re.Execute(u)(0)
        GroupKey = m.SubMatches(0) & "|" & m.SubMatches(1)
    Else
        GroupKey = u
    End If
End Function

' representative = first member of each family found in Plan Orders
Private Sub EnsureRepMap()
    If Not repMap Is Nothing Then
        If Timer >= repBuiltAt And Timer - repBuiltAt < 5 Then Exit Sub
    End If
    Set repMap = NewDict()
    repBuiltAt = Timer
    Dim orders As Worksheet
    On Error Resume Next
    Set orders = Sheets("Plan Orders")
    On Error GoTo 0
    If orders Is Nothing Then Exit Sub
    Dim oLast As Long: oLast = orders.Cells(orders.Rows.Count, 1).End(xlUp).Row
    If oLast < 2 Then Exit Sub
    Dim oV As Variant: oV = orders.Range("B2:B" & oLast).Value
    Dim i As Long
    For i = 1 To UBound(oV, 1)
        Dim b As String: b = UCase$(Trim$(CStr(oV(i, 1) & "")))
        If b <> "" Then
            Dim k As String: k = GroupKey(b)
            If Not repMap.Exists(k) Then repMap.Add k, b
        End If
    Next i
End Sub
