package io.github.jqssun.airplay.ui

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Color
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.util.Base64
import android.view.MotionEvent
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

private const val HOST = "ace-hud.local"
private const val ROOT = "https://ace-hud.local/"
private val files = mapOf(
    "index.html" to "text/html",
    "hud.css" to "text/css",
    "airplay.css" to "text/css",
    "read-hud.js" to "application/javascript",
    "tesseract.min.js" to "application/javascript",
    "worker.min.js" to "application/javascript",
    "tesseract-core-lstm.wasm.js" to "application/javascript",
    "ukr.traineddata" to "application/octet-stream",
    "rus.traineddata" to "application/octet-stream"
)

@SuppressLint("SetJavaScriptEnabled")
internal class NavigationHud(context: Context) : WebView(context) {
    private var ready = false

    init {
        setBackgroundColor(Color.TRANSPARENT)
        settings.javaScriptEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val uri: Uri = request.url
                val name = uri.path?.removePrefix("/")
                val mime = files[name]
                if (uri.scheme != "https" || uri.host != HOST || mime == null || name == null || request.method != "GET") {
                    return WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(byteArrayOf()))
                }
                return WebResourceResponse(mime, if (mime == "application/octet-stream") null else "UTF-8",
                    context.assets.open("ace-hud/$name"))
            }

            override fun onPageFinished(view: WebView, url: String) {
                ready = url == ROOT + "index.html"
            }
        }
        loadUrl(ROOT + "index.html")
    }

    // Keep fullscreen controls on the Compose layer. The page is a display only.
    override fun onTouchEvent(event: MotionEvent) = false

    fun postFrame(bitmap: Bitmap) {
        try {
            if (!ready || !isAttachedToWindow) return
            val panels = Bitmap.createBitmap(512, 1112, Bitmap.Config.ARGB_8888)
            try {
                val canvas = Canvas(panels)
                canvas.drawColor(Color.BLACK)
                val paint = Paint(Paint.FILTER_BITMAP_FLAG)
                // Leave the map, system bar, and route history out of the OCR payload.
                for (panel in listOf(Rect(12, 95, 492, 182), Rect(18, 984, 286, 1068))) {
                    val source = Rect(panel.left, panel.top * bitmap.height / 1112,
                        panel.right, panel.bottom * bitmap.height / 1112)
                    canvas.drawBitmap(bitmap, source, panel, paint)
                }
                val encoded = ByteArrayOutputStream().use { stream ->
                    if (!panels.compress(Bitmap.CompressFormat.PNG, 100, stream)) return
                    Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
                }
                evaluateJavascript("window.aceHudFrame && window.aceHudFrame('$encoded')", null)
            } finally {
                panels.recycle()
            }
        } finally {
            bitmap.recycle()
        }
    }
}
