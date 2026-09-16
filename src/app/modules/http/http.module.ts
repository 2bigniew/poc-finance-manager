import { Global, Module, Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { HttpClientConfig } from '@config/http.config';
import { HTTP_CLIENT } from './http.constants';

const axiosProvider: Provider = {
  provide: HTTP_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): AxiosInstance => {
    const httpConfig = configService.getOrThrow<HttpClientConfig>('http');
    return axios.create({
      timeout: httpConfig.timeoutMs,
    });
  },
};

@Global()
@Module({
  imports: [ConfigModule],
  providers: [axiosProvider],
  exports: [HTTP_CLIENT],
})
export class HttpModule {}
