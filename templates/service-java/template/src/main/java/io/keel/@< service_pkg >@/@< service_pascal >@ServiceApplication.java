package io.keel.@< service_pkg >@;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/** The reference service entrypoint: boots the Spring context composed onto keel-core. */
@SpringBootApplication
public class @< service_pascal >@ServiceApplication {
  public static void main(String[] args) {
    SpringApplication.run(@< service_pascal >@ServiceApplication.class, args);
  }
}
