import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'director', description: 'Login nick or email' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  login!: string;

  @ApiProperty({ example: 'Director123!' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
