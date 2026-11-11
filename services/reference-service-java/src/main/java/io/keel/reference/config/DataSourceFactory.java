package io.keel.reference.config;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.net.URI;
import javax.sql.DataSource;

/**
 * Builds the connection pool from the cross-vertical {@code KEEL_DATABASE_URL}, which is a
 * libpq-style {@code postgres://user:pass@host:port/db} DSN (the same form the other verticals
 * accept). JDBC needs a {@code jdbc:postgresql://} URL with the credentials split out, so this
 * converts it; a URL already in {@code jdbc:} form is used as-is. HikariCP fails fast at startup if
 * the database is unreachable.
 */
public final class DataSourceFactory {

  private DataSourceFactory() {}

  public static DataSource from(String url) {
    HikariConfig config = new HikariConfig();
    if (url.startsWith("jdbc:")) {
      config.setJdbcUrl(url);
    } else {
      URI uri = URI.create(url);
      StringBuilder jdbcUrl = new StringBuilder("jdbc:postgresql://").append(uri.getHost());
      if (uri.getPort() > 0) {
        jdbcUrl.append(':').append(uri.getPort());
      }
      // Use the raw (still-encoded) path/query so a percent-encoded db name or connection
      // param (e.g. options=-c%20search_path=foo) is preserved for JDBC rather than decoded to
      // a literal space; the user-info is decoded below for the Hikari credential setters.
      String rawPath = uri.getRawPath();
      jdbcUrl.append((rawPath == null || rawPath.isEmpty()) ? "/" : rawPath);
      if (uri.getRawQuery() != null) {
        jdbcUrl.append('?').append(uri.getRawQuery());
      }
      config.setJdbcUrl(jdbcUrl.toString());
      if (uri.getUserInfo() != null) {
        String[] credentials = uri.getUserInfo().split(":", 2);
        config.setUsername(credentials[0]);
        if (credentials.length > 1) {
          config.setPassword(credentials[1]);
        }
      }
    }
    return new HikariDataSource(config);
  }
}
