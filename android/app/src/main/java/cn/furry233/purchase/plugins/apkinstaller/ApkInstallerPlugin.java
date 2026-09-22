/**
 * Android 插件：ApkInstaller（应用内下载安装 APK）
 *
 * 对外方法（前端通过 window.Capacitor.Plugins.ApkInstaller 调用）：
 *   · canInstall        查询「允许安装未知来源应用」权限是否已授予（Android 8+）；
 *   · requestPermission 跳转到系统设置页请求该权限；
 *   · install(url, sha256, packageName) 后台线程下载 APK → 计算 SHA-256 与期望值比对 → 
 *     校验 APK 包名 → 通过 FileProvider 拉起系统安装界面，并持续 emit 进度与结果事件。
 * 事件：progress（下载百分比/已下载/总大小）、result（installed / cancelled / failed + 原因）。
 * 安全考虑：不做静默安装（需用户确认），完整性校验失败立即中止并清理临时文件。
 */
package cn.furry233.purchase.plugins.apkinstaller;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 应用内更新安装插件：
 *  - install(): 后台下载 APK → SHA-256 完整性校验 → 校验包名为本应用 → 拉起系统安装界面
 *  - canInstall(): 是否已具备「安装未知应用」权限（Android 8.0+）
 *  - requestPermission(): 跳转到系统「允许来自此来源的应用」设置页
 *  - 结果回调：notifyListeners("installResult")；进度回调：notifyListeners("progress")
 *
 * 兼容性：
 *  - Android 8.0+（API 26）：REQUEST_INSTALL_PACKAGES 未知来源安装权限
 *  - Android 11+（API 30）：包可见性通过 Intent/FileProvider 授权，不使用静默安装（受系统限制）
 *  - Android 7.0+：使用 FileProvider 授权 content:// URI
 */
@CapacitorPlugin(name = "ApkInstaller", requestCodes = { ApkInstallerPlugin.REQUEST_INSTALL })
public class ApkInstallerPlugin extends Plugin {

    static final int REQUEST_INSTALL = 9127;
    static final int REQUEST_UNKNOWN_SOURCE = 9128;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private File pendingApk;
    private long pendingApkVersionCode = 0;

    /** 当前是否允许安装未知来源应用 */
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject ret = new JSObject();
        boolean allowed = canRequestInstalls();
        ret.put("canInstall", allowed);
        ret.put("sdkInt", Build.VERSION.SDK_INT);
        if (allowed) {
            ret.put("reason", "");
        } else {
            ret.put("reason", Build.VERSION.SDK_INT >= 26
                    ? "系统未授予「安装未知应用」权限"
                    : "系统已关闭「未知来源」安装开关");
        }
        call.resolve(ret);
    }

    /** 打开系统设置，让用户授予安装权限（无法静默授予，属于系统安全限制） */
    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 26) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                getContext().startActivity(intent);
                JSObject ret = new JSObject();
                ret.put("status", "settings-opened");
                call.resolve(ret);
                return;
            } catch (Exception e) {
                call.reject("无法打开系统设置：" + e.getMessage());
                return;
            }
        }
        JSObject ret = new JSObject();
        ret.put("status", "not-required");
        call.resolve(ret);
    }

    /** 下载并校验后拉起安装界面 */
    @PluginMethod
    public void install(PluginCall call) {
        String url = call.getString("url");
        String sha256 = call.getString("sha256");
        String fileName = call.getString("fileName", "update.apk");

        if (url == null || url.isEmpty()) {
            call.reject("缺少下载地址");
            return;
        }
        if (!canRequestInstalls()) {
            JSObject ret = new JSObject();
            ret.put("status", "permission-required");
            ret.put("message", "需要授予「安装未知应用」权限");
            call.resolve(ret);
            return;
        }

        final String finalUrl = url;
        final String finalSha = sha256 == null ? "" : sha256.trim().toLowerCase();
        final String finalName = fileName;

        getBridge().saveCall(call);
        executor.execute(() -> {
            try {
                File dir = new File(getContext().getCacheDir(), "updates");
                if (!dir.exists() && !dir.mkdirs()) throw new Exception("无法创建更新目录");
                // 清理旧的安装包，避免残留
                File[] olds = dir.listFiles();
                if (olds != null) {
                    for (File f : olds) {
                        if (f.isFile()) f.delete();
                    }
                }
                File target = new File(dir, finalName);
                download(finalUrl, target);
                emitProgress(100, target.length(), target.length());

                // 1) 完整性校验（SHA-256）
                if (!finalSha.isEmpty()) {
                    String actual = sha256Of(target);
                    if (!finalSha.equalsIgnoreCase(actual)) {
                        target.delete();
                        emitResult("failed", "安装包校验失败（SHA-256 不匹配），已删除，请重试");
                        resolveSaved("failed", "安装包校验失败（SHA-256 不匹配）");
                        return;
                    }
                }

                // 2) 校验 APK 合法性与包名（防止装错应用）
                PackageManager pm = getContext().getPackageManager();
                PackageInfo archive = pm.getPackageArchiveInfo(target.getAbsolutePath(), 0);
                if (archive == null || archive.packageName == null) {
                    target.delete();
                    emitResult("failed", "安装包解析失败，文件可能已损坏");
                    resolveSaved("failed", "安装包解析失败，文件可能已损坏");
                    return;
                }
                if (!getContext().getPackageName().equals(archive.packageName)) {
                    target.delete();
                    emitResult("failed", "安装包与本应用不匹配，已终止安装");
                    resolveSaved("failed", "安装包与本应用不匹配");
                    return;
                }
                pendingApkVersionCode = archive.versionCode;

                pendingApk = target;
                emitResult("verified", "校验通过，正在打开安装程序");
                openInstaller(target);
            } catch (Exception e) {
                emitResult("failed", "下载失败：" + e.getMessage());
                resolveSaved("failed", "下载失败：" + e.getMessage());
            }
        });
    }

    /** 安装界面返回结果：区分「已安装 / 用户取消 / 安装失败」 */
    @Override
    protected void handleOnActivityResult(int requestCode, int resultCode, Intent data) {
        super.handleOnActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_INSTALL) return;

        PluginCall call = getSavedCall();
        if (call == null) return;

        // 以「实际安装版本是否达到目标版本」为准，避免仅靠 resultCode 误判
        long installed = getInstalledVersionCode();
        if (pendingApkVersionCode > 0 && installed >= pendingApkVersionCode) {
            emitResult("installed", "安装完成");
            resolveSaved("installed", "安装完成");
            return;
        }
        if (resultCode == android.app.Activity.RESULT_CANCELED) {
            emitResult("cancelled", "用户取消了安装");
            resolveSaved("cancelled", "用户取消了安装");
            return;
        }
        emitResult("failed", "安装未完成，可重试");
        resolveSaved("failed", "安装未完成，可重试");
    }

    /* ------------------------------ 内部实现 ------------------------------ */

    private void openInstaller(File file) throws Exception {
        Uri uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                file
        );
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PluginCall call = getSavedCall();
        if (call != null) {
            startActivityForResult(call, intent, REQUEST_INSTALL);
        } else {
            getContext().startActivity(intent);
        }
    }

    private boolean canRequestInstalls() {
        if (Build.VERSION.SDK_INT >= 26) {
            return getContext().getPackageManager().canRequestPackageInstalls();
        }
        try {
            return Settings.Secure.getInt(
                    getContext().getContentResolver(),
                    Settings.Secure.INSTALL_NON_MARKET_APPS
            ) == 1;
        } catch (Exception e) {
            return true; // 旧版本默认允许，交给系统在安装时提示
        }
    }

    private long getInstalledVersionCode() {
        try {
            PackageInfo info = getContext()
                    .getPackageManager()
                    .getPackageInfo(getContext().getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    private void download(String urlStr, File target) throws Exception {
        HttpURLConnection conn = null;
        InputStream in = null;
        OutputStream out = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setInstanceFollowRedirects(true);
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) throw new Exception("HTTP " + code);

            long total = conn.getContentLength();
            in = new BufferedInputStream(conn.getInputStream());
            out = new FileOutputStream(target);
            byte[] buffer = new byte[32 * 1024];
            int read;
            long done = 0;
            long lastEmit = 0;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
                done += read;
                long now = System.currentTimeMillis();
                if (now - lastEmit > 120) {
                    lastEmit = now;
                    emitProgress(total > 0 ? (int) (done * 100 / total) : 0, done, total);
                }
            }
            out.flush();
        } finally {
            if (out != null) try { out.close(); } catch (Exception ignored) {}
            if (in != null) try { in.close(); } catch (Exception ignored) {}
            if (conn != null) conn.disconnect();
        }
    }

    private void emitProgress(int percent, long received, long total) {
        JSObject ret = new JSObject();
        ret.put("percent", percent);
        ret.put("received", received);
        ret.put("total", total);
        notifyListeners("progress", ret);
    }

    private void emitResult(String status, String message) {
        JSObject ret = new JSObject();
        ret.put("status", status);
        ret.put("message", message);
        notifyListeners("installResult", ret);
    }

    private void resolveSaved(String status, String message) {
        PluginCall call = getSavedCall();
        if (call == null) return;
        JSObject ret = new JSObject();
        ret.put("status", status);
        ret.put("message", message);
        call.resolve(ret);
    }

    private static String sha256Of(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        InputStream in = null;
        try {
            in = new BufferedInputStream(new java.io.FileInputStream(file));
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                digest.update(buffer, 0, read);
            }
        } finally {
            if (in != null) try { in.close(); } catch (Exception ignored) {}
        }
        byte[] hash = digest.digest();
        StringBuilder sb = new StringBuilder();
        for (byte b : hash) sb.append(String.format("%02x", b));
        return sb.toString();
    }
}
