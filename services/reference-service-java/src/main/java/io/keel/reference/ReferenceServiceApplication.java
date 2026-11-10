package io.keel.reference;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/** The reference service entrypoint: boots the Spring context composed onto keel-core. */
@SpringBootApplication
public class ReferenceServiceApplication {
  public static void main(String[] args) {
    SpringApplication.run(ReferenceServiceApplication.class, args);
  }
}
