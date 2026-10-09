package de.earthcraft;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Locale;

/** HTTP client for the local EarthCraft tile service (see service/src/server.mjs). */
public final class ServiceClient {
	private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
	private static Process serviceProcess;
	private static long lastLaunchAttempt;

	private ServiceClient() {}

	public static String base() {
		return EarthConfig.get().serviceUrl.replaceAll("/+$", "");
	}

	public static String originQuery(double lat, double lon, double h) {
		return String.format(Locale.ROOT, "lat=%.8f&lon=%.8f&h=%.4f", lat, lon, h);
	}

	public static byte[] getBytes(String pathAndQuery, Duration timeout) throws IOException, InterruptedException {
		HttpRequest req = HttpRequest.newBuilder(URI.create(base() + pathAndQuery)).timeout(timeout).GET().build();
		HttpResponse<byte[]> res = HTTP.send(req, HttpResponse.BodyHandlers.ofByteArray());
		if (res.statusCode() != 200) {
			throw new IOException("service " + res.statusCode() + ": " + new String(res.body()).trim());
		}
		return res.body();
	}

	public static JsonObject getJson(String pathAndQuery, Duration timeout) throws IOException, InterruptedException {
		return JsonParser.parseString(new String(getBytes(pathAndQuery, timeout))).getAsJsonObject();
	}

	public static boolean healthy() {
		try {
			return getJson("/health", Duration.ofSeconds(2)).get("ok").getAsBoolean();
		} catch (Exception e) {
			return false;
		}
	}

	/** Starts the Node service if it is not running and serviceDir is configured. */
	public static synchronized void ensureRunning() {
		if (healthy()) return;
		EarthConfig cfg = EarthConfig.get();
		if (cfg.serviceDir == null || cfg.serviceDir.isBlank()) return;
		if (serviceProcess != null && serviceProcess.isAlive()) return;
		if (System.currentTimeMillis() - lastLaunchAttempt < 15000) return;
		lastLaunchAttempt = System.currentTimeMillis();
		try {
			File dir = new File(cfg.serviceDir);
			ProcessBuilder pb = new ProcessBuilder(cfg.nodeExecutable, "--max-old-space-size=8192", "src/server.mjs").directory(dir)
				.redirectErrorStream(true)
				.redirectOutput(ProcessBuilder.Redirect.appendTo(new File(dir, "service.log")));
			serviceProcess = pb.start();
			EarthCraft.LOGGER.info("Started EarthCraft service in {}", dir);
			Runtime.getRuntime().addShutdownHook(new Thread(() -> serviceProcess.destroy()));
			for (int i = 0; i < 50 && !healthy(); i++) Thread.sleep(200);
		} catch (Exception e) {
			EarthCraft.LOGGER.error("Could not start the EarthCraft service", e);
		}
	}
}
