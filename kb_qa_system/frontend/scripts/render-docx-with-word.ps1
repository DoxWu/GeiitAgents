param(
  [Parameter(Mandatory = $true)][string]$InputDocx,
  [Parameter(Mandatory = $true)][string]$OutputPdf
)

$ErrorActionPreference = 'Stop'
$word = $null
$document = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $word.AutomationSecurity = 3
  $document = $word.Documents.Open($InputDocx, $false, $true, $false)
  $document.Repaginate()
  $pages = $document.ComputeStatistics(2)
  $paragraphs = $document.Paragraphs.Count
  $tables = $document.Tables.Count
  $document.ExportAsFixedFormat($OutputPdf, 17)
  $document.Close($false)
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document)
  $document = $null
  $word.Quit()
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word)
  $word = $null
  [pscustomobject]@{ pages = $pages; paragraphs = $paragraphs; tables = $tables; pdfBytes = (Get-Item -LiteralPath $OutputPdf).Length } | ConvertTo-Json -Compress
} finally {
  if ($document) { try { $document.Close($false) } catch {}; [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) }
  if ($word) { try { $word.Quit() } catch {}; [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
